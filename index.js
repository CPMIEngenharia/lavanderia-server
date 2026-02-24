/*
 * SERVIDOR LAVANDERIA IOT - V4 (AUTONOMIA DO CLIENTE)
 * - Multi-Cliente: Cada um com sua conta Mercado Pago.
 * - Multi-Planilha: Cada cliente controla seus próprios preços no seu Google Drive.
 * SERVIDOR LAVANDERIA IOT V5 - MULTI-CLIENTE & MULTI-PLANILHA
 * Centraliza o controle de preços e pagamentos de todos os franqueados.
*/

const express = require('express');
@@ -11,176 +10,137 @@ const cors = require('cors');
const bodyParser = require('body-parser');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

// --- AUTENTICAÇÃO GOOGLE (O Robô que lê as planilhas) ---
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
app.use(express.static('public')); // Serve a pasta onde estará o index.html

// ==================================================================
// --- 1. CADASTRO DE CLIENTES (AGENDA COMPLETA) ---
// --- 1. BANCO DE DADOS DOS CLIENTES (Configure aqui) ---
// ==================================================================
// Agora guardamos 2 coisas: O Token do Banco e o ID da Planilha DELE.

const CLIENTES = {
    // MÁQUINA DO PEDRO
"lavadora01": {
        dono: "Pedro",
        token_mp: "APP-USR-TOKEN-DO-PEDRO",
        sheet_id: "ID_DA_PLANILHA_DO_PEDRO_1A2B3C" 
    },

    // MÁQUINA DO JOÃO (Pode usar a mesma planilha para todas as máquinas dele)
    "lavadora02": {
        dono: "João",
        dono: "Joao",
token_mp: "APP-USR-TOKEN-DO-JOAO",
        sheet_id: "ID_DA_PLANILHA_DO_JOAO_XYZ123" 
        sheet_id: "ID-DA-PLANILHA-DO-JOAO"
},
    "secadora02": {
        dono: "João",
    "secadora01": {
        dono: "Joao",
token_mp: "APP-USR-TOKEN-DO-JOAO",
        sheet_id: "ID_DA_PLANILHA_DO_JOAO_XYZ123" 
        sheet_id: "ID-DA-PLANILHA-DO-JOAO"
    },
    "lavadora02": {
        dono: "Maria",
        token_mp: "APP-USR-TOKEN-DA-MARIA",
        sheet_id: "ID-DA-PLANILHA-DA-MARIA"
}
};

// ==================================================================
// --- 2. FUNÇÃO: BUSCAR PREÇO NA PLANILHA DO CLIENTE ---
// --- 2. CONFIGURAÇÃO GOOGLE AUTH ---
// ==================================================================
async function buscarPrecoDinamico(idMaquina, tipoCiclo) {
    try {
        const dadosCliente = CLIENTES[idMaquina];
        if (!dadosCliente) return null;

        // Carrega a planilha ESPECÍFICA deste cliente
        const doc = new GoogleSpreadsheet(dadosCliente.sheet_id, serviceAccountAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0]; 
        const rows = await sheet.getRows();

        // Procura a configuração da máquina (para saber se tem preço específico por máquina)
        // Se a planilha do João tiver só 1 linha genérica, ele pode chamar de "padrao"
        // Ou ele pode listar "lavadora02" e colocar o preço.
        
        // Tentamos achar a linha com o ID exato da máquina.
        // Se não achar, tentamos achar uma linha "padrao".
        let linha = rows.find(row => row.get('id_maquina') === idMaquina);
        if (!linha) {
             linha = rows.find(row => row.get('id_maquina') === 'padrao');
        }

        if (!linha) return null; // Não achou preço nem pra máquina nem padrão

        let precoString = "0";
        if (tipoCiclo == "15") precoString = linha.get('preco_15');
        else if (tipoCiclo == "45") precoString = linha.get('preco_45');
        else if (tipoCiclo == "secar") precoString = linha.get('preco_secar');

        return parseFloat(precoString.replace(',', '.'));

    } catch (error) {
        console.error(`Erro ao ler planilha do cliente ${idMaquina}:`, error);
        return null; 
    }
}
const auth = new JWT({
  email: process.env.GOOGLE_SERVICE_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ==================================================================
// --- 3. CONFIGURAÇÃO MQTT ---
// --- 3. CONFIGURAÇÃO MQTT (HIVEMQ) ---
// ==================================================================
const mqttClient = mqtt.connect("mqtts://d54e131cfd444c24b4775af5044e1a33.s1.eu.hivemq.cloud:8883", {
username: "servidorlv_nodejs",
password: "Lave2025",
rejectUnauthorized: false 
});

mqttClient.on('connect', () => console.log("MQTT: Conectado com Sucesso"));

// ==================================================================
// --- 4. ROTA DE PAGAMENTO ---
// --- 4. ROTA: GERAR PAGAMENTO (PIX) ---
// ==================================================================
app.post('/criar_pagamento', async (req, res) => {
try {
const { id_maquina, tempo } = req.body;
        
        // 1. Identifica o Cliente
        const dadosCliente = CLIENTES[id_maquina];
        if (!dadosCliente) return res.status(400).json({ error: "Máquina não cadastrada." });
        const dados = CLIENTES[id_maquina];

        console.log(`Pedido para ${dadosCliente.dono} (Maq: ${id_maquina})`);
        if (!dados) return res.status(404).json({ error: "Máquina não cadastrada." });

        // 2. Busca o preço na planilha DELE
        const valorReal = await buscarPrecoDinamico(id_maquina, tempo);
        // A. Busca Preço na Planilha do Cliente
        const doc = new GoogleSpreadsheet(dados.sheet_id, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        
        const linha = rows.find(r => r.get('id_maquina') === id_maquina) || rows.find(r => r.get('id_maquina') === 'padrao');

        if (!valorReal) return res.status(400).json({ error: "Erro de preço ou planilha inacessível." });
        let preco = 0;
        if (tempo === "15") preco = linha.get('preco_15');
        else if (tempo === "45") preco = linha.get('preco_45');
        else if (tempo === "secar") preco = linha.get('preco_secar');

        console.log(`Preço definido pelo ${dadosCliente.dono}: R$ ${valorReal}`);
        const valorFinal = parseFloat(preco.toString().replace(',', '.'));

        // 3. Gera Pix na conta DELE
        const client = new MercadoPagoConfig({ accessToken: dadosCliente.token_mp });
        const payment = new Payment(client);
        // B. Cria o Pagamento no Mercado Pago do Cliente
        const mpClient = new MercadoPagoConfig({ accessToken: dados.token_mp });
        const payment = new Payment(mpClient);

        const result = await payment.create({
        const mpRes = await payment.create({
body: {
                transaction_amount: valorReal,
                description: `Lavanderia ${dadosCliente.dono} - ${id_maquina}`,
                transaction_amount: valorFinal,
                description: `Ciclo ${tempo}min - ${id_maquina}`,
payment_method_id: 'pix',
                payer: { email: 'cliente@email.com' },
                payer: { email: 'pagamento@lavanderia.com' },
external_reference: `${id_maquina}|${tempo}`
}
});

res.json({
status: "ok",
            valor: valorReal, // Retorna o valor pro Front mostrar pro usuário
            qr_code: result.point_of_interaction.transaction_data.qr_code,
            qr_base64: result.point_of_interaction.transaction_data.qr_code_base64,
            payment_id: result.id
            valor: valorFinal,
            qr_code: mpRes.point_of_interaction.transaction_data.qr_code,
            qr_base64: mpRes.point_of_interaction.transaction_data.qr_code_base64,
            payment_id: mpRes.id
});

} catch (error) {
        console.error("Erro no pagamento:", error);
        res.status(500).json({ error: "Erro interno" });
        console.error("Erro Criar Pagamento:", error);
        res.status(500).json({ error: "Erro ao processar" });
}
});

// ==================================================================
// --- 5. WEBHOOK ---
// --- 5. WEBHOOK: RECEBER CONFIRMAÇÃO ---
// ==================================================================
app.post('/webhook', async (req, res) => {
    const topic = req.query.topic || req.query.type;
const id = req.query.id || req.query['data.id'];

    if (topic === 'payment') {
        let pagamentoInfo = null;
        
        // Varre os clientes para achar o pagamento
        // (Nota: Isso pode ser otimizado com banco de dados no futuro)
        for (const [keyMaq, dados] of Object.entries(CLIENTES)) {
    
    if (id) {
        // Varre os tokens cadastrados para achar o pagamento aprovado
        for (const [key, dados] of Object.entries(CLIENTES)) {
try {
                const client = new MercadoPagoConfig({ accessToken: dados.token_mp });
                const payment = new Payment(client);
                const mpClient = new MercadoPagoConfig({ accessToken: dados.token_mp });
                const payment = new Payment(mpClient);
const info = await payment.get({ id: id });

if (info && info.status === 'approved') {
                    pagamentoInfo = info;
                    const [maquina, tempo] = info.external_reference.split('|');
                    
                    // Publica no tópico exato da máquina
                    mqttClient.publish(`lavanderia/${maquina}/comandos`, JSON.stringify({ tempo: tempo }));
                    console.log(`PAGO: Liberando ${maquina} por ${tempo}min`);
break;
}
            } catch (e) {}
        }

        if (pagamentoInfo) {
            const [maquinaAlvo, tempoAlvo] = pagamentoInfo.external_reference.split('|');
            const mensagem = JSON.stringify({ tempo: tempoAlvo });
            
            mqttClient.publish(`lavanderia/${maquinaAlvo}/comandos`, mensagem);
            console.log(`CICLO INICIADO: ${maquinaAlvo} (${tempoAlvo} min)`);
            } catch (e) { /* Próximo token */ }
}
}
res.status(200).send("OK");
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
