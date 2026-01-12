/*
 * SERVIDOR LAVANDERIA IOT - V4 (AUTONOMIA DO CLIENTE)
 * - Multi-Cliente: Cada um com sua conta Mercado Pago.
 * - Multi-Planilha: Cada cliente controla seus próprios preços no seu Google Drive.
 */

const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const mqtt = require('mqtt');
const cors = require('cors');
const bodyParser = require('body-parser');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
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

// ==================================================================
// --- 1. CADASTRO DE CLIENTES (AGENDA COMPLETA) ---
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
        token_mp: "APP-USR-TOKEN-DO-JOAO",
        sheet_id: "ID_DA_PLANILHA_DO_JOAO_XYZ123" 
    },
    "secadora02": {
        dono: "João",
        token_mp: "APP-USR-TOKEN-DO-JOAO",
        sheet_id: "ID_DA_PLANILHA_DO_JOAO_XYZ123" 
    }
};

// ==================================================================
// --- 2. FUNÇÃO: BUSCAR PREÇO NA PLANILHA DO CLIENTE ---
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

// ==================================================================
// --- 3. CONFIGURAÇÃO MQTT ---
// ==================================================================
const mqttClient = mqtt.connect("mqtts://d54e131cfd444c24b4775af5044e1a33.s1.eu.hivemq.cloud:8883", {
    username: "servidorlv_nodejs",
    password: "Lave2025",
    rejectUnauthorized: false 
});

// ==================================================================
// --- 4. ROTA DE PAGAMENTO ---
// ==================================================================
app.post('/criar_pagamento', async (req, res) => {
    try {
        const { id_maquina, tempo } = req.body;
        
        // 1. Identifica o Cliente
        const dadosCliente = CLIENTES[id_maquina];
        if (!dadosCliente) return res.status(400).json({ error: "Máquina não cadastrada." });

        console.log(`Pedido para ${dadosCliente.dono} (Maq: ${id_maquina})`);

        // 2. Busca o preço na planilha DELE
        const valorReal = await buscarPrecoDinamico(id_maquina, tempo);
        
        if (!valorReal) return res.status(400).json({ error: "Erro de preço ou planilha inacessível." });

        console.log(`Preço definido pelo ${dadosCliente.dono}: R$ ${valorReal}`);

        // 3. Gera Pix na conta DELE
        const client = new MercadoPagoConfig({ accessToken: dadosCliente.token_mp });
        const payment = new Payment(client);

        const result = await payment.create({
            body: {
                transaction_amount: valorReal,
                description: `Lavanderia ${dadosCliente.dono} - ${id_maquina}`,
                payment_method_id: 'pix',
                payer: { email: 'cliente@email.com' },
                external_reference: `${id_maquina}|${tempo}`
            }
        });

        res.json({
            status: "ok",
            valor: valorReal, // Retorna o valor pro Front mostrar pro usuário
            qr_code: result.point_of_interaction.transaction_data.qr_code,
            qr_base64: result.point_of_interaction.transaction_data.qr_code_base64,
            payment_id: result.id
        });

    } catch (error) {
        console.error("Erro no pagamento:", error);
        res.status(500).json({ error: "Erro interno" });
    }
});

// ==================================================================
// --- 5. WEBHOOK ---
// ==================================================================
app.post('/webhook', async (req, res) => {
    const topic = req.query.topic || req.query.type;
    const id = req.query.id || req.query['data.id'];

    if (topic === 'payment') {
        let pagamentoInfo = null;
        
        // Varre os clientes para achar o pagamento
        // (Nota: Isso pode ser otimizado com banco de dados no futuro)
        for (const [keyMaq, dados] of Object.entries(CLIENTES)) {
            try {
                const client = new MercadoPagoConfig({ accessToken: dados.token_mp });
                const payment = new Payment(client);
                const info = await payment.get({ id: id });
                if (info && info.status === 'approved') {
                    pagamentoInfo = info;
                    break;
                }
            } catch (e) {}
        }

        if (pagamentoInfo) {
            const [maquinaAlvo, tempoAlvo] = pagamentoInfo.external_reference.split('|');
            const mensagem = JSON.stringify({ tempo: tempoAlvo });
            
            mqttClient.publish(`lavanderia/${maquinaAlvo}/comandos`, mensagem);
            console.log(`CICLO INICIADO: ${maquinaAlvo} (${tempoAlvo} min)`);
        }
    }
    res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
