/*
 * SERVIDOR LAVANDERIA IOT V5 - MULTI-CLIENTE & MULTI-PLANILHA
 * Centraliza o controle de preços e pagamentos de todos os franqueados.
 */

const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const mqtt = require('mqtt');
const cors = require('cors');
const bodyParser = require('body-parser');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public')); // Serve a pasta onde estará o index.html

// ==================================================================
// --- 1. BANCO DE DADOS DOS CLIENTES (Configure aqui) ---
// ==================================================================
const CLIENTES = {
    "lavadora01": {
        dono: "Joao",
        token_mp: "APP-USR-TOKEN-DO-JOAO",
        sheet_id: "ID-DA-PLANILHA-DO-JOAO"
    },
    "secadora01": {
        dono: "Joao",
        token_mp: "APP-USR-TOKEN-DO-JOAO",
        sheet_id: "ID-DA-PLANILHA-DO-JOAO"
    },
    "lavadora02": {
        dono: "Maria",
        token_mp: "APP-USR-TOKEN-DA-MARIA",
        sheet_id: "ID-DA-PLANILHA-DA-MARIA"
    }
};

// ==================================================================
// --- 2. CONFIGURAÇÃO GOOGLE AUTH ---
// ==================================================================
const auth = new JWT({
  email: process.env.GOOGLE_SERVICE_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ==================================================================
// --- 3. CONFIGURAÇÃO MQTT (HIVEMQ) ---
// ==================================================================
const mqttClient = mqtt.connect("mqtts://d54e131cfd444c24b4775af5044e1a33.s1.eu.hivemq.cloud:8883", {
    username: "servidorlv_nodejs",
    password: "Lave2025",
    rejectUnauthorized: false 
});

mqttClient.on('connect', () => console.log("MQTT: Conectado com Sucesso"));

// ==================================================================
// --- 4. ROTA NOVA: ENVIAR PREÇOS PARA O APP DO CLIENTE ---
// ==================================================================
app.get('/api/precos/:id', async (req, res) => {
    try {
        const id_maquina = req.params.id;
        const dados = CLIENTES[id_maquina];

        if (!dados) {
            return res.json({ erro: true, mensagem: "Máquina não encontrada" });
        }

        const doc = new GoogleSpreadsheet(dados.sheet_id, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        
        const linha = rows.find(r => r.get('id_maquina') === id_maquina) || rows.find(r => r.get('id_maquina') === 'padrao');
        
        if (!linha) {
             return res.json({ erro: true, mensagem: "Preços não configurados" });
        }

        // Função de Limpeza de Moeda (Transforma R$ 15,00 em 15.00)
        const limparValor = (valor) => {
            if (!valor) return 0;
            const numero = parseFloat(String(valor).replace('R$', '').replace(/\s/g, '').replace(',', '.'));
            return isNaN(numero) ? 0 : numero;
        };

        res.json({
            preco_15: limparValor(linha.get('preco_15')),
            preco_45: limparValor(linha.get('preco_45')),
            preco_secar: limparValor(linha.get('preco_secar'))
        });

    } catch (error) {
        console.error("Erro ao buscar preços:", error);
        res.json({ erro: true });
    }
});

// ==================================================================
// --- 5. ROTA: GERAR PAGAMENTO (PIX) ---
// ==================================================================
app.post('/criar_pagamento', async (req, res) => {
    try {
        const { id_maquina, tempo } = req.body;
        // Compatibilidade com o index.html novo que envia "ciclo" ao invés de "tempo"
        const ciclo = req.body.ciclo || tempo; 
        const dados = CLIENTES[id_maquina];

        if (!dados) return res.status(404).json({ error: "Máquina não cadastrada." });

        // A. Busca Preço na Planilha do Cliente
        const doc = new GoogleSpreadsheet(dados.sheet_id, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        
        const linha = rows.find(r => r.get('id_maquina') === id_maquina) || rows.find(r => r.get('id_maquina') === 'padrao');
        
        let preco = 0;
        // Compatibilidade para aceitar tanto os nomes antigos ("15", "45") quanto os novos ("preco_15", etc)
        if (ciclo === "15" || ciclo === "preco_15") preco = linha.get('preco_15');
        else if (ciclo === "45" || ciclo === "preco_45") preco = linha.get('preco_45');
        else if (ciclo === "secar" || ciclo === "preco_secar") preco = linha.get('preco_secar');

        const valorFinal = parseFloat(preco.toString().replace('R$', '').replace(/\s/g, '').replace(',', '.'));

        if (isNaN(valorFinal) || valorFinal <= 0) {
            return res.status(400).json({ error: "Preço inválido ou zerado." });
        }

        // B. Cria o Pagamento no Mercado Pago do Cliente
        const mpClient = new MercadoPagoConfig({ accessToken: dados.token_mp });
        const payment = new Payment(mpClient);

        // Ajusta o tempo para o Webhook entender corretamente
        let tempoNotificacao = "45";
        if (ciclo === "15" || ciclo === "preco_15") tempoNotificacao = "15";

        const mpRes = await payment.create({
            body: {
                transaction_amount: valorFinal,
                description: `Ciclo ${tempoNotificacao}min - ${id_maquina}`,
                payment_method_id: 'pix',
                payer: { email: 'pagamento@lavanderia.com' },
                external_reference: `${id_maquina}|${tempoNotificacao}`
            }
        });

        res.json({
            status: "ok",
            valor: valorFinal,
            qr_code: mpRes.point_of_interaction.transaction_data.qr_code,
            qr_base64: mpRes.point_of_interaction.transaction_data.qr_code_base64,
            payment_id: mpRes.id,
            init_point: mpRes.point_of_interaction.transaction_data.ticket_url
        });

    } catch (error) {
        console.error("Erro Criar Pagamento:", error);
        res.status(500).json({ error: "Erro ao processar" });
    }
});

// ==================================================================
// --- 6. WEBHOOK: RECEBER CONFIRMAÇÃO ---
// ==================================================================
app.post('/webhook', async (req, res) => {
    const id = req.query.id || req.query['data.id'];
    
    if (id) {
        // Varre os tokens cadastrados para achar o pagamento aprovado
        for (const [key, dados] of Object.entries(CLIENTES)) {
            try {
                const mpClient = new MercadoPagoConfig({ accessToken: dados.token_mp });
                const payment = new Payment(mpClient);
                const info = await payment.get({ id: id });

                if (info && info.status === 'approved') {
                    const [maquina, tempo] = info.external_reference.split('|');
                    
                    // Publica no tópico exato da máquina
                    mqttClient.publish(`lavanderia/${maquina}/comandos`, JSON.stringify({ tempo: tempo }));
                    console.log(`PAGO: Liberando ${maquina} por ${tempo}min`);
                    break;
                }
            } catch (e) { /* Próximo token */ }
        }
    }
    res.status(200).send("OK");
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
