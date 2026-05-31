/*
 * SERVIDOR LAVANDERIA IOT V5 - MULTI-CLIENTE & MULTI-PLANILHA
 * Centraliza o controle de preços e pagamentos de todos os franqueados.
 * Pagamento via Checkout Mercado Pago (PIX e Cartão, sem Boleto).
*/

const express = require('express');
const axios = require('axios');
const mqtt = require('mqtt');
const { google } = require('googleapis');
const path = require('path');
const cookieParser = require('cookie-parser');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- O GUARDA DE TRÂNSITO ---
app.get('/', (req, res, next) => {
    if (req.query.id) {
        return res.redirect('/app/' + req.query.id);
    }
    next();
});

app.use(express.static('public'));

// --- 1. CONFIGURAÇÕES ---
const MASTER_SHEET_ID = "19427ddGD6PLr38I_hELCd6OhA89UycUyTNt-h7Exb8I";

let CLIENTES = {}; 
let STATUS_CACHE = {};
let INTENTS_ATIVOS = {};
let CACHE_DADOS_MAQUINAS = {}; // A nossa "Memória RAM" super rápida!

// --- 2. FUNÇÃO DE AUTENTICAÇÃO ---
function getGoogleAuth() {
    return new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Permite Ler e Escrever
    });
}

// --- 3. CARREGAR CONFIGURAÇÕES MESTRE ---
async function carregarConfiguracoes() {
    console.log("🔄 Atualizando lista de máquinas e donos...");
    try {
        const auth = getGoogleAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: 'CONFIG_GERAL!A:F' 
        });

        const linhas = response.data.values;
        if (linhas && linhas.length > 1) {
            CLIENTES = {}; 
            for (let i = 1; i < linhas.length; i++) {
                const [id, dono, token, sheet, maquininha, deviceId] = linhas[i];
                if (id && dono) {
                    CLIENTES[id.trim()] = { 
                        dono: dono.trim(), 
                        token_mp: token ? token.trim() : "", 
                        sheet_id: sheet ? sheet.trim() : "",
                        usa_maquininha: maquininha && String(maquininha).trim().toUpperCase() === "SIM",
                        device_id: deviceId ? deviceId.trim() : "" 
                    };
                }
            }
            console.log(`✅ Configuração Carregada: ${Object.keys(CLIENTES).length} máquinas.`);
        }
    } catch (err) {
        console.error("❌ Erro ao ler Planilha Mestre:", err.message);
    }
}

// --- 4. O ROBÔ DE CACHE (Velocidade da Luz) ---
async function sincronizarPrecosPlanilhas() {
    console.log("🔄 Sincronizando preços e tempos do Google Sheets para a Memória (CACHE)...");
    
    const sheetsUnicas = [...new Set(Object.values(CLIENTES).map(c => c.sheet_id).filter(id => id))];
    
    for (let sheetId of sheetsUnicas) {
        try {
            const auth = getGoogleAuth();
            const sheets = google.sheets({ version: 'v4', auth });
            const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A:Z' });
            
            const linhas = response.data.values;
            if (!linhas || linhas.length === 0) continue;
            
            const cabecalho = linhas[0];
            const colTempo = cabecalho.findIndex(c => c && (c.trim() === 'Tempo do Ciclo' || c.trim() === 'Tempo Padrão'));
            const colLavar = cabecalho.findIndex(c => c && (c.trim() === 'Preço_lavar' || c.trim() === 'Preço Padrão' || c.trim() === 'preco_45'));
            const colSecar = cabecalho.findIndex(c => c && (c.trim() === 'preco_secar' || c.trim() === 'Preço Secar'));

            for (let i = 1; i < linhas.length; i++) {
                let idMaq = linhas[i][0];
                if (!idMaq) continue;
                idMaq = idMaq.trim();
                
                let pLavar = colLavar !== -1 && linhas[i][colLavar] ? linhas[i][colLavar].toString().replace('R$', '').replace(',', '.').trim() : "0";
                let pSecar = colSecar !== -1 && linhas[i][colSecar] ? linhas[i][colSecar].toString().replace('R$', '').replace(',', '.').trim() : "0";
                let tCiclo = colTempo !== -1 && linhas[i][colTempo] ? linhas[i][colTempo].toString().trim() : "45";
                
                CACHE_DADOS_MAQUINAS[idMaq] = {
                    preco_lavar: pLavar,
                    preco_secar: pSecar,
                    tempo: tCiclo
                };
            }
        } catch (err) {
            console.error("❌ Erro ao sincronizar a planilha ID:", sheetId);
        }
    }
    console.log("✅ CACHE DE PREÇOS ATUALIZADO COM SUCESSO! Velocidade turbo ativada.");
}

// Inicia as varreduras de fundo
carregarConfiguracoes();
setInterval(carregarConfiguracoes, 600000); 
setTimeout(sincronizarPrecosPlanilhas, 5000); 
setInterval(sincronizarPrecosPlanilhas, 120000); // Atualiza o Cache a cada 2 minutos

// --- 5. FUNÇÃO AUXILIAR INSTANTÂNEA (LÊ DA MEMÓRIA RAM) ---
async function buscarDadosNaPlanilha(sheetId, idMaquina, colunaPreco) {
    let dados = CACHE_DADOS_MAQUINAS[idMaquina];
    if (!dados) return { preco: "0", tempo: "45" }; 

    let precoCerto = "0";
    if (colunaPreco.includes('sec')) precoCerto = dados.preco_secar;
    else precoCerto = dados.preco_lavar;

    return { preco: precoCerto, tempo: dados.tempo };
}

async function autenticarUsuarioNaPlanilha(usuario, senha) {
    try {
        const auth = getGoogleAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: 'Login!A:C' });
        const linhas = response.data.values;
        if (!linhas) return null;
        
        const header = linhas[0];
        const colUser = header.findIndex(h => h.trim() === 'usuario_login');
        const colPass = header.findIndex(h => h.trim() === 'senha_acesso');
        const colDono = header.findIndex(h => h.trim() === 'dono');

        const linhaUsuario = linhas.find(row => row[colUser] && row[colUser].trim() === usuario.trim() && row[colPass] && String(row[colPass]).trim() === String(senha).trim());
        return linhaUsuario ? linhaUsuario[colDono].trim() : null;
    } catch (err) { return null; }
}

// --- 6. CONEXÃO MQTT (HIVEMQ) ---
const mqttClient = mqtt.connect('mqtts://89c0f9913b464fe793a20c71d78ec5c6.s1.eu.hivemq.cloud:8883', {
    username: 'unileve', password: 'Unilevepassword1', rejectUnauthorized: false,
});

mqttClient.on('connect', () => {
    console.log("✅ MQTT Conectado");
    mqttClient.subscribe('lavanderia/+/status');
});

mqttClient.on('message', (topic, message) => {
    const partes = topic.split('/');
    if (partes.length === 3 && partes[2] === 'status') {
        const idMaquina = partes[1];
        STATUS_CACHE[idMaquina] = message.toString();
    }
});

// --- 7. PAINEL DO DONO (COM EDIÇÃO DE PLANILHA) ---
app.get('/painel', (req, res) => {
    const donoLogado = req.cookies.dono;

    if (!donoLogado) {
        return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#2c3e50;margin:0}.card{background:white;padding:2rem;border-radius:10px;text-align:center;width:90%;max-width:320px}input{width:100%;padding:10px;margin-bottom:10px}button{width:100%;padding:10px;background:#27ae60;color:white;border:none;border-radius:5px}</style></head><body><div class="card"><h2>Unileve Admin</h2><form action="/login" method="POST"><input type="text" name="usuario" placeholder="Usuário" required><input type="password" name="senha" placeholder="Senha" required><button type="submit">ENTRAR</button></form></div></body></html>`);
    }

    let maquinasDoDono = Object.keys(CLIENTES)
        .filter(id => CLIENTES[id].dono === donoLogado)
        .sort((a, b) => {
            let isSecA = a.toLowerCase().includes('sec');
            let isSecB = b.toLowerCase().includes('sec');
            if (isSecA === isSecB) return a.localeCompare(b);
            return isSecA ? 1 : -1; 
        });

    let htmlCards = maquinasDoDono.map(id => {
        let statusReal = STATUS_CACHE[id] || "AGUARDANDO...";
        let corBadge = "gray"; let textoBadge = "OFFLINE";
        if (statusReal.includes("DISPONIVEL")) { corBadge = "#27ae60"; textoBadge = "ONLINE"; } 
        else if (statusReal.includes("LAVANDO") || statusReal.includes("ENXAGUE") || statusReal.includes("CENTRIF") || statusReal.includes("SECANDO") || statusReal.includes("TEMPO:")) { corBadge = "#e67e22"; textoBadge = "OCUPADA"; }

        const isSecadora = id.toLowerCase().includes('sec');

        let botaoCicloNormal = isSecadora 
            ? `<button onclick="acionar('${id}', 'CMD_SECAR')" style="width:100%; background:#e67e22; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer;">🔥 FORÇAR SECAR</button>`
            : `<button onclick="acionar('${id}', 'CMD_45')" style="width:100%; background:#2980b9; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer; margin-bottom:8px;">💧 FORÇAR LAVAR 45M</button>
               <button onclick="acionar('${id}', 'CMD_ENXAGUE')" style="width:100%; background:#1abc9c; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer;">🌀 SÓ ENXÁGUE/CENTR.</button>`;

        return `<div class="card" style="background:white; padding:15px; border-radius:8px; margin-bottom:15px; box-shadow:0 2px 4px rgba(0,0,0,0.1)">
            <h3 style="margin-top:0;">${id.toUpperCase()}</h3>
            <span id="badge-${id}" style="background:${corBadge};color:white;padding:4px 8px;border-radius:4px;font-size:12px; font-weight:bold; transition: 0.3s;">${textoBadge}</span>
            
            <div id="status-texto-${id}" style="margin-top:10px; font-family:monospace; font-size:14px; color:#2c3e50; font-weight:bold; background:#e8f4f8; padding:8px; border-radius:4px;">
                ${statusReal}
            </div>

            <div style="margin-top:15px; padding:10px; background:#f8f9fa; border-radius:8px; border:1px solid #ddd;">
                <p style="font-size:12px; margin:0 0 5px 0; color:#333; font-weight:bold;">📝 Alterar Padrão na Planilha:</p>
                <div style="display:flex; gap:5px;">
                    <input type="text" id="preco-${id}" placeholder="Preço (Ex: 15,00)" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px;">
                    <input type="number" id="tempo-${id}" placeholder="Tempo (Min)" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px;">
                </div>
                <button onclick="salvarPlanilha('${id}')" style="width:100%; margin-top:8px; background:#2c3e50; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 SALVAR MUDANÇAS</button>
            </div>

            <div style="margin-top:15px;">${botaoCicloNormal}</div>
            
            <div style="margin-top:8px; display:grid; grid-template-columns:1fr 1fr; gap:5px;">
                <button onclick="acionar('${id}', 'CMD_FORCA_LIGA')" style="background:#8e44ad; color:white; border:none; padding:8px; border-radius:4px; font-size:12px; cursor:pointer;">⚙️ FORÇAR LIGA</button>
                <button onclick="acionar('${id}', 'CMD_FORCA_START')" style="background:#f1c40f; color:#333; border:none; padding:8px; border-radius:4px; font-size:12px; font-weight:bold; cursor:pointer;">⚙️ FORÇAR START</button>
            </div>

            <button onclick="acionar('${id}', 'CMD_RESET')" style="width:100%; margin-top:8px; background:#c0392b; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer;">🚨 RESET DE EMERGÊNCIA</button>
        </div>`;
    }).join('');

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif; background:#ecf0f1; padding:20px}</style></head><body>
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <h2>Olá, ${donoLogado}</h2>
            <a href="/logout" style="color:#c0392b; text-decoration:none; font-weight:bold;">Sair</a>
        </div>
        <p style="font-size:12px; color:#7f8c8d;">Status e Tempo de Ciclo em Tempo Real ⏳</p>
        <hr>
        ${htmlCards}
        
        <script>
        function acionar(id, cmd){ 
            if(confirm('Enviar '+cmd+' para '+id+'?')) {
                fetch('/api/acionar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,cmd})})
                .then(r=>r.json())
                .then(d=>alert(d.success ? 'Comando Enviado!' : 'Erro ao enviar comando')) 
            }
        }

        function salvarPlanilha(id) {
            const preco = document.getElementById('preco-' + id).value;
            const tempo = document.getElementById('tempo-' + id).value;
            
            if(!preco && !tempo) return alert('Preencha o preço ou o tempo!');
            
            document.getElementById('preco-' + id).value = "Salvando...";
            
            fetch('/api/atualizar_planilha', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ id_maquina: id, preco: preco, tempo: tempo })
            })
            .then(r => r.json())
            .then(d => {
                document.getElementById('preco-' + id).value = "";
                document.getElementById('tempo-' + id).value = "";
                if(d.success) alert('✅ Salvo na Planilha com sucesso!');
                else alert('❌ Erro: ' + d.error);
            }).catch(e => alert('Erro de conexão!'));
        }

        setInterval(() => {
            fetch('/api/status_geral')
            .then(res => res.json())
            .then(dados => {
                for (let id in dados) {
                    let badge = document.getElementById('badge-' + id);
                    let statusBox = document.getElementById('status-texto-' + id);
                    if (badge) {
                        let status = dados[id];
                        if (statusBox) statusBox.innerText = status;

                        if (status.includes("DISPONIVEL")) {
                            badge.style.background = "#27ae60"; badge.innerText = "ONLINE";
                        } else if (status.includes("LAVANDO") || status.includes("ENXAGUE") || status.includes("CENTRIF") || status.includes("SECANDO") || status.includes("TEMPO:")) {
                            badge.style.background = "#e67e22"; badge.innerText = "OCUPADA";
                        } else {
                            badge.style.background = "gray"; badge.innerText = "OFFLINE";
                        }
                    }
                }
            })
            .catch(e => console.log("Aguardando reconexão..."));
        }, 2000); 
        </script>
    </body></html>`);
});

// --- ROTA: ATUALIZAR PLANILHA PELO PAINEL E FORÇAR CACHE ---
function getColLetter(colIndex) {
    let letter = '';
    while (colIndex >= 0) {
        letter = String.fromCharCode((colIndex % 26) + 65) + letter;
        colIndex = Math.floor(colIndex / 26) - 1;
    }
    return letter;
}

app.post('/api/atualizar_planilha', async (req, res) => {
    const dono = req.cookies.dono;
    const { id_maquina, preco, tempo } = req.body;
    
    if (!dono || !CLIENTES[id_maquina] || CLIENTES[id_maquina].dono !== dono) return res.status(403).json({ error: "Proibido" });

    try {
        const sheetId = CLIENTES[id_maquina].sheet_id;
        const auth = getGoogleAuth();
        const sheets = google.sheets({ version: 'v4', auth });

        const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A:Z' });
        const linhas = response.data.values;
        const cabecalho = linhas[0];

        const linhaIndex = linhas.findIndex(l => l[0] && l[0].trim() === id_maquina.trim());
        if (linhaIndex === -1) return res.status(404).json({ error: "Máquina não achada" });

        const rowNumber = linhaIndex + 1; 

        const colPrecoIndex = cabecalho.findIndex(c => c && c.trim() === 'Preço Padrão');
        const colTempoIndex = cabecalho.findIndex(c => c && (c.trim() === 'Tempo do Ciclo' || c.trim() === 'Tempo Padrão'));

        if (preco && colPrecoIndex !== -1) {
            const letraCol = getColLetter(colPrecoIndex);
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId, range: `${letraCol}${rowNumber}`,
                valueInputOption: 'USER_ENTERED', requestBody: { values: [[preco]] }
            });
        }

        if (tempo && colTempoIndex !== -1) {
            const letraCol = getColLetter(colTempoIndex);
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId, range: `${letraCol}${rowNumber}`,
                valueInputOption: 'USER_ENTERED', requestBody: { values: [[tempo]] }
            });
        }

        // Força a atualização do cache interno na hora!
        setTimeout(sincronizarPrecosPlanilhas, 1000);

        res.json({ success: true });
    } catch(e) {
        console.error("Erro Planilha:", e);
        res.status(500).json({ error: "Erro de permissão no Google" });
    }
});

// --- 8. ROTAS DE API (LOGIN E ACIONAMENTOS) ---
app.get('/api/status_geral', (req, res) => { res.json(STATUS_CACHE); });

app.post('/login', async (req, res) => {
    const { usuario, senha } = req.body;
    const nomeDono = await autenticarUsuarioNaPlanilha(usuario, senha);
    if (nomeDono) { 
        res.cookie('dono', nomeDono, { httpOnly: true, maxAge: 86400000 }); 
        res.redirect('/painel'); 
    } else { 
        res.send(`Usuário/Senha incorretos. <a href="/painel">Voltar</a>`); 
    }
});

app.get('/logout', (req, res) => { res.clearCookie('dono'); res.redirect('/painel'); });

app.post('/api/acionar', (req, res) => {
    const dono = req.cookies.dono;
    const { id, cmd } = req.body;
    if (!dono || !CLIENTES[id] || CLIENTES[id].dono !== dono) return res.status(403).json({ error: "Proibido" });
    
    mqttClient.publish(`lavanderia/${id}/comandos`, cmd, { qos: 1 });
    res.json({ success: true });
});

// --- 9. TELA DO CLIENTE (DO ADESIVO) ---
app.get('/app/:id', async (req, res) => {
    const id = req.params.id;
    if (!CLIENTES[id]) return res.send("<h2>Erro: Máquina não encontrada.</h2>");
    
    const config = CLIENTES[id];
    const isSecadora = id.toLowerCase().includes('sec');
    const tipoMaquina = isSecadora ? 'SECADORA' : 'LAVADORA';
    
    const matchNumeros = id.match(/\d+$/);
    const numeroMaquina = matchNumeros ? matchNumeros[0] : "";

    let tipoPreco = isSecadora ? 'preco_secar' : 'preco_45';

    let botaoFisicoHtml = '';
    if (config.usa_maquininha) {
        botaoFisicoHtml = `<button onclick="pagarFisico('${id}','${tipoPreco}')" style="background:#e67e22; margin-top:15px;">💳 PAGAR NA MAQUININHA FÍSICA</button>`;
    }

    res.send(`<!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { text-align:center; font-family:sans-serif; padding:20px; background:#ecf0f1; margin:0; }
            .box { background:white; padding:20px; border-radius:15px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); margin-bottom: 20px;}
            button { width:100%; padding:20px; font-size:16px; border-radius:10px; border:none; color:white; font-weight:bold; cursor:pointer; margin-top:10px; }
            .btn-pix { background: #27ae60; }
            .btn-online { background: #8e44ad; }
            .btn-copiar { background: #34495e; padding: 15px; font-size: 14px;}
            #areaPix { display: none; margin-top: 20px; }
            #imgPix { width: 250px; height: 250px; margin: 10px auto; border: 2px solid #bdc3c7; border-radius: 10px; padding: 10px;}
            #textoCopiaCola { width: 100%; padding: 10px; box-sizing: border-box; font-size: 12px; margin-bottom: 10px; color: #7f8c8d; word-break: break-all; background: #f8f9fa; border: 1px solid #ddd; border-radius: 5px;}
        </style>
    </head>
    <body>
        <div class="box">
            <h1 style="margin: 0; color:#2c3e50;">${tipoMaquina} ${numeroMaquina}</h1>
            <p style="color:#7f8c8d; margin-top:5px;">Loja: ${config.dono}</p>
            
            <div id="areaBotoes">
                <button class="btn-pix" onclick="gerarPix('${id}','${tipoPreco}')">🟢 PAGAR COM PIX (RÁPIDO)</button>
                <button class="btn-online" onclick="pagarOnline('${id}','${tipoPreco}')">💳 PAGAR CARTÃO NO CELULAR</button>
                ${botaoFisicoHtml}
            </div>

            <div id="areaPix">
                <h3 style="color:#27ae60;">Escaneie ou copie o código abaixo:</h3>
                <img id="imgPix" src="" alt="QR Code Pix" />
                <textarea id="textoCopiaCola" rows="3" readonly></textarea>
                <button class="btn-copiar" onclick="copiarPix()">📋 COPIAR PIX</button>
                <p style="font-size: 14px; color: #e67e22; margin-top: 15px;">⏳ Aguardando pagamento... A máquina ligará automaticamente.</p>
            </div>
            
            <div id="msgAprovado" style="display:none; margin-top:20px; color: #27ae60; font-weight: bold; font-size: 24px;">
                ✅ Pagamento Aprovado! <br><span style="font-size: 16px; color: #333;">Sua máquina já foi liberada.</span>
            </div>
        </div>

        <script>
        function gerarPix(id, tempo){ 
            document.getElementById('areaBotoes').innerHTML = "<p>⏳ Gerando PIX...</p>"; 
            fetch('/api/gerar_pix', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({id_maquina: id, tempo: tempo})
            }).then(r => r.json()).then(d => {
                if (d.success) {
                    document.getElementById('areaBotoes').style.display = 'none';
                    document.getElementById('areaPix').style.display = 'block';
                    document.getElementById('imgPix').src = "data:image/jpeg;base64," + d.qr_code_base64;
                    document.getElementById('textoCopiaCola').value = d.qr_code;
                    iniciarMonitoramento(id);
                } else { alert('Erro: ' + (d.error || 'Falha.')); window.location.reload(); }
            }).catch(e => { alert('Erro.'); window.location.reload(); });
        }

        function pagarOnline(id, tempo){
            document.getElementById('areaBotoes').innerHTML = "<p style='color:#8e44ad; font-weight:bold; font-size:18px;'>⏳ Redirecionando...</p>";
            fetch('/criar_pagamento', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({id_maquina: id, tempo: tempo})
            }).then(r => r.json()).then(d => {
                if(d.init_point) window.location.href = d.init_point;
                else { alert('Erro: ' + (d.error || 'Falha')); window.location.reload(); }
            }).catch(e => { alert('Erro.'); window.location.reload(); });
        }

        function pagarFisico(id, tempo){
            document.getElementById('areaBotoes').innerHTML = "<p style='color:#e67e22; font-weight:bold; font-size:18px;'>⏳ Acordando maquininha...</p>";
            fetch('/api/pagar_fisico', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_maquina: id, tempo: tempo })
            }).then(r => r.json()).then(d => {
                if(d.error) { alert("Atenção: " + d.error); window.location.reload(); } 
                else {
                    document.getElementById('areaBotoes').innerHTML = "<div style='font-size:60px;'>💳</div><p style='color:#27ae60; font-weight:bold; font-size:20px;'>Aproxime/Insira o cartão na maquininha ao lado!</p>";
                    iniciarMonitoramento(id);
                }
            }).catch(e => { alert('Erro na maquininha.'); window.location.reload(); });
        }

        function copiarPix() {
            var copyText = document.getElementById("textoCopiaCola");
            copyText.select(); copyText.setSelectionRange(0, 99999);
            navigator.clipboard.writeText(copyText.value).then(() => { alert("PIX copiado!"); });
        }

        function iniciarMonitoramento(id) {
            setInterval(async () => {
                try {
                    let res = await fetch('/api/status_geral?t=' + new Date().getTime(), { cache: 'no-store' });
                    let statusCache = await res.json();
                    let st = statusCache[id] || "DISPONIVEL";
                    let isOcupada = st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("ENXAGUE") || st.includes("CENTRIF") || st.includes("OCUPADA") || st.includes("TEMPO:");
                    
                    if (isOcupada) {
                        document.getElementById('areaPix').style.display = 'none';
                        document.getElementById('areaBotoes').style.display = 'none';
                        document.getElementById('msgAprovado').style.display = 'block';
                    }
                } catch(e) {}
            }, 3000);
        }
        </script>
    </body>
    </html>`);
});

// --- 10. CRIAÇÃO DE PAGAMENTO ONLINE E PIX TRANSPARENTE ---
app.post('/criar_pagamento', async (req, res) => {
    let { id_maquina, tempo } = req.body;
    
    if (tempo === '45' || tempo === 'CMD_45') tempo = 'preco_45';
    if (String(tempo).toLowerCase().includes('sec')) tempo = 'preco_secar';

    const config = CLIENTES[id_maquina];
    if (!config) return res.status(400).json({ error: "Máquina não configurada" });
    
    if (STATUS_CACHE[id_maquina] && STATUS_CACHE[id_maquina].includes('TEMPO:')) {
        return res.status(400).json({ error: "MÁQUINA EM USO." });
    }

    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero na planilha" });

        const emailDinamico = `cliente_${Date.now()}@lavanderia.com`; 
        let comandoPlaca = id_maquina.toLowerCase().includes('sec') ? `SECAR:${dados.tempo}` : `LAVAR:${dados.tempo}`;

        const preference = {
            items: [{ title: `Ciclo ${dados.tempo}min - ${id_maquina}`, unit_price: parseFloat(dados.preco), quantity: 1, currency_id: 'BRL' }],
            metadata: { maquina: id_maquina, comando: comandoPlaca }, 
            payer: { email: emailDinamico },
            payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }], installments: 1 },
            notification_url: "https://lavanderia-v2.onrender.com/webhook",
            back_urls: { success: "https://lavanderia-v2.onrender.com/sucesso", failure: "https://lavanderia-v2.onrender.com/erro" },
            auto_return: "approved",
        };

        const response = await axios.post('https://api.mercadopago.com/checkout/preferences', preference, {
            headers: { 'Authorization': `Bearer ${config.token_mp}` }
        });
        
        res.json({ status: 'ok', init_point: response.data.init_point });
    } catch (e) { 
        console.error("❌ Erro MP:", e.message); res.status(500).json({ error: "Erro no MP" }); 
    }
});

app.post('/api/gerar_pix', async (req, res) => {
    let { id_maquina, tempo } = req.body;
    
    if (tempo === '45' || tempo === 'CMD_45') tempo = 'preco_45';
    if (String(tempo).toLowerCase().includes('sec')) tempo = 'preco_secar';

    const config = CLIENTES[id_maquina];
    if (!config) return res.status(400).json({ error: "Máquina não configurada" });
    
    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero na planilha" });

        let comandoPlaca = id_maquina.toLowerCase().includes('sec') ? `SECAR:${dados.tempo}` : `LAVAR:${dados.tempo}`;
        const emailDinamico = `cliente_${Date.now()}@lavanderia.com`; 

        const paymentData = {
            transaction_amount: parseFloat(dados.preco),
            description: `Unileve - ${id_maquina.toUpperCase()}`,
            payment_method_id: "pix",
            payer: { email: emailDinamico },
            metadata: { maquina: id_maquina, comando: comandoPlaca },
            notification_url: "https://lavanderia-v2.onrender.com/webhook"
        };

        const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
            headers: { 
                'Authorization': `Bearer ${config.token_mp}`,
                'X-Idempotency-Key': `${id_maquina}-${Date.now()}`
            }
        });
        
        const qrCodeImg = response.data.point_of_interaction.transaction_data.qr_code_base64;
        const qrCodeCopiaCola = response.data.point_of_interaction.transaction_data.qr_code;

        res.json({ success: true, qr_code_base64: qrCodeImg, qr_code: qrCodeCopiaCola });
    } catch (e) { res.status(500).json({ error: "Erro Pix." }); }
});

// --- 11. O WEBHOOK (QUE DISPARA OS COMANDOS) ---
app.post('/webhook', async (req, res) => {
    let tipoEvento = req.query.type || req.body.type || req.body.action || req.query.topic;

    // FÍSICO (STONE POS)
    if (tipoEvento === 'point_integration_wh') {
        const info = req.body;
        if (info.state === 'FINISHED' && info.payment && info.payment.state === 'approved' && info.additional_info && info.additional_info.external_reference) {
            const partes = info.additional_info.external_reference.split('|');
            const maquina = partes[0]; 
            const comando = partes[1]; // Aqui já vem o SECAR:60

            if (maquina && comando) {
                mqttClient.publish(`lavanderia/${maquina}/comandos`, comando, { qos: 1 });
                STATUS_CACHE[maquina] = 'OCUPADA';
                console.log(`✅ FÍSICO APROVADO! LIGANDO A MÁQUINA: ${maquina} -> ${comando}`);
                return res.sendStatus(200);
            }
        }
        return res.sendStatus(200);
    }

    // ONLINE E PIX TRANSPARENTE
    if (tipoEvento === 'payment' || tipoEvento === 'payment.created') {
        const idPagamento = (req.body.data && req.body.data.id) ? req.body.data.id : req.query['data.id'];
        if (idPagamento) {
            const tokensUnicos = [...new Set(Object.values(CLIENTES).map(c => c.token_mp))];
            for (const token of tokensUnicos) {
                try {
                    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${idPagamento}`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    
                    if (response.data.status === 'approved') {
                        let maquina = null;
                        let comando = null;

                        if (response.data.metadata && response.data.metadata.maquina) {
                            maquina = response.data.metadata.maquina;
                            comando = response.data.metadata.comando || (maquina.includes('sec') ? 'CMD_SECAR' : 'CMD_45');
                        } else if (response.data.external_reference && response.data.external_reference.includes('|')) {
                            const partes = response.data.external_reference.split('|');
                            maquina = partes[0]; 
                            comando = partes[1]; 
                        }

                        if (maquina && comando) {
                            mqttClient.publish(`lavanderia/${maquina}/comandos`, comando, { qos: 1 });
                            STATUS_CACHE[maquina] = 'OCUPADA';
                            console.log(`✅ ONLINE APROVADO! LIGANDO A MÁQUINA: ${maquina} -> ${comando}`);
                            return res.sendStatus(200);
                        }
                    }
                } catch (err) { continue; }
            }
        }
    }
    res.sendStatus(200);
});

// --- 12. ROTAS DA MAQUININHA FÍSICA (STONE POS) ---
app.post('/api/pagar_fisico', async (req, res) => {
    let { id_maquina, tempo } = req.body;
    const config = CLIENTES[id_maquina];

    if (!config || !config.device_id) return res.status(400).json({ error: "Máquina não configurada." });

    if (INTENTS_ATIVOS[id_maquina]) {
        try {
            await axios.delete(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents/${INTENTS_ATIVOS[id_maquina]}`, {
                headers: { 'Authorization': `Bearer ${config.token_mp}` }
            });
        } catch(e) {}
        delete INTENTS_ATIVOS[id_maquina]; 
    }

    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero na planilha." });

        let comandoWebhook = id_maquina.toLowerCase().includes('sec') ? `SECAR:${dados.tempo}` : `LAVAR:${dados.tempo}`;
        const valorEmCentavos = Math.round(parseFloat(dados.preco) * 100);

        const ordemPagamento = {
            amount: valorEmCentavos,
            description: `Unileve - ${id_maquina.toUpperCase()}`,
            additional_info: {
                external_reference: `${id_maquina}|${comandoWebhook}`,
                print_on_terminal: false
            }
        };

        const response = await axios.post(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents`, ordemPagamento, {
            headers: { 'Authorization': `Bearer ${config.token_mp}` }
        });
        
        INTENTS_ATIVOS[id_maquina] = response.data.id;
        res.json({ success: true, intent_id: response.data.id });

    } catch (error) { res.status(500).json({ error: "Falha ao comunicar com a maquininha." }); }
});

app.post('/api/cancelar_fisico', async (req, res) => {
    const { id_maquina } = req.body;
    const config = CLIENTES[id_maquina];
    const intentId = INTENTS_ATIVOS[id_maquina];
    if (!config || !intentId) return res.json({ success: false });
    try {
        await axios.delete(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents/${intentId}`, {
            headers: { 'Authorization': `Bearer ${config.token_mp}` }
        });
        delete INTENTS_ATIVOS[id_maquina]; 
    } catch (e) {}
    res.json({ success: true });
});

app.get('/limpar-fila/:id_maquina', async (req, res) => {
    const id = req.params.id_maquina;
    const config = CLIENTES[id];
    if (!config || !config.device_id) return res.send("Máquina sem DEVICE_ID");
    try {
        await axios.delete(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents`, {
            headers: { 'Authorization': `Bearer ${config.token_mp}` }
        });
        res.send("<h2 style='color:green;'>✅ Fila limpa com sucesso! A máquina está livre.</h2>");
    } catch (error) {
        res.send("<h2>Não havia fila para limpar ou deu erro.</h2><p>" + error.message + "</p>");
    }
});

// --- 13. TELA DO TOTEM (AUTOATENDIMENTO TABLET) ---
app.get('/totem/:donoUrl', (req, res) => {
    const donoRequisitado = req.params.donoUrl.toLowerCase();
    
    let maquinasDaLoja = Object.keys(CLIENTES)
        .filter(id => CLIENTES[id].dono.toLowerCase() === donoRequisitado);

    if (maquinasDaLoja.length === 0) {
        return res.send("<h1 style='text-align:center; font-family:sans-serif; margin-top:50px; color:#2c3e50;'>Nenhuma máquina encontrada para esta loja.</h1>");
    }

    let torres = {};
    maquinasDaLoja.forEach(id => {
        let numMatch = id.match(/\d+$/);
        let numero = numMatch ? numMatch[0] : id.toUpperCase();
        if (!torres[numero]) torres[numero] = {};
        
        if (id.toLowerCase().includes('sec')) {
            torres[numero].secadora = id;
        } else {
            torres[numero].lavadora = id;
        }
    });

    function gerarBotao(idOriginal, isSecadora) {
        if (!idOriginal) return '';
        let numMatch = idOriginal.match(/\d+$/);
        let numero = numMatch ? numMatch[0] : idOriginal.toUpperCase();
        let nomeAmigavel = (isSecadora ? 'SECADORA ' : 'LAVADORA ') + numero;
        let icone = isSecadora ? '🔥' : '💧';

        let st = STATUS_CACHE[idOriginal] || "DISPONIVEL";
        let isOcupada = st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("ENXAGUE") || st.includes("CENTRIF") || st.includes("OCUPADA") || st.includes("TEMPO:");

        if (isOcupada) {
            return `
            <div id="${idOriginal}" class="botao-maq ocupada" onclick="alert('Esta máquina já está lavando roupas de outro cliente!')">
                <div style="font-size:50px;">${icone}</div>
                <h2 style="margin:10px 0;">${nomeAmigavel}</h2>
                <div id="badge-${idOriginal}" style="background:rgba(0,0,0,0.2); border-radius:8px; padding:10px; font-weight:bold;">EM USO ⏳</div>
            </div>`;
        } else {
            let classe = isSecadora ? 'secadora-livre' : 'lavadora-livre';
            return `
            <div id="${idOriginal}" class="botao-maq ${classe}" onclick="abrirConfirmacao('${nomeAmigavel}', '${idOriginal}')">
                <div style="font-size:50px;">${icone}</div>
                <h2 style="margin:10px 0;">${nomeAmigavel}</h2>
                <div id="badge-${idOriginal}" style="background:rgba(0,0,0,0.2); border-radius:8px; padding:10px; font-weight:bold;">TOCAR PARA PAGAR</div>
            </div>`;
        }
    }

    let htmlTorres = '';
    Object.keys(torres).sort((a,b) => parseInt(a) - parseInt(b)).forEach(numero => {
        htmlTorres += `
        <div class="torre">
            <h3 class="titulo-torre">CONJUNTO ${numero}</h3>
            ${gerarBotao(torres[numero].secadora, true)}
            ${gerarBotao(torres[numero].lavadora, false)}
        </div>`;
    });

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Unileve - Autoatendimento</title>
        <style>
            body { font-family: sans-serif; background: #ecf0f1; margin: 0; padding: 30px; user-select: none; }
            h1 { text-align: center; color: #2c3e50; font-size: 36px; margin-bottom: 5px; }
            p.subtitulo { text-align: center; color: #7f8c8d; font-size: 20px; margin-bottom: 40px; }
            .loja-container { display: flex; justify-content: center; gap: 40px; flex-wrap: wrap; max-width: 1200px; margin: 0 auto; }
            .torre { display: flex; flex-direction: column; gap: 20px; width: 300px; background: #dfe6e9; padding: 20px; border-radius: 20px; box-shadow: inset 0 4px 8px rgba(0,0,0,0.05); }
            .titulo-torre { text-align: center; color: #34495e; margin: 0 0 10px 0; font-size: 24px; font-weight: bold; }
            .botao-maq { border-radius:15px; padding:30px 20px; color:white; text-align:center; cursor:pointer; box-shadow: 0 6px 12px rgba(0,0,0,0.15); transition: transform 0.1s; }
            .botao-maq:active { transform: scale(0.97); }
            .secadora-livre { background: #e67e22; }
            .lavadora-livre { background: #2980b9; }
            .ocupada { background: #95a5a6; opacity: 0.6; cursor: not-allowed; }
            .overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 1000; color: white; text-align: center; justify-content: center; align-items: center; flex-direction: column; }
            .btn-acao { padding: 20px 40px; font-size: 22px; font-weight: bold; color: white; border: none; border-radius: 10px; cursor: pointer; margin: 10px; }
            .btn-sim { background: #2ecc71; }
            .btn-nao { background: #e74c3c; }
            .btn-escolha { padding: 30px; font-size: 26px; border-radius: 15px; width: 100%; max-width: 500px; margin: 10px 0; border: none; color: white; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 15px; }
            .btn-cartao { background: #e67e22; }
            .btn-cartao:active { background: #d35400; }
            .btn-pix { background: #27ae60; }
            .btn-pix:active { background: #2ecc71; }
        </style>
    </head>
    <body>
        <h1>Bem-vindo à Unileve</h1>
        <p class="subtitulo">Toque na máquina que você deseja usar:</p>
        
        <div class="loja-container">
            ${htmlTorres}
        </div>

        <div id="
