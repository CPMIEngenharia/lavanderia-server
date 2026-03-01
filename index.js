/*
 * SERVIDOR LAVANDERIA IOT V5 - MULTI-CLIENTE & MULTI-PLANILHA
 * Centraliza o controle de preços e pagamentos de todos os franqueados.
 * Pagamento via Checkout Mercado Pago (PIX e Cartão, sem Boleto).
*/

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const path = require('path');
const mqtt = require('mqtt'); // <-- Adicionado import do MQTT
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago'); // <-- Import correto do MP
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public')); // Serve a pasta onde estará o index.html

// ==================================================================
// --- 1. AUTENTICAÇÃO GOOGLE (O Robô que lê as planilhas) ---
// ==================================================================
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ==================================================================
// --- 2. BANCO DE DADOS DOS CLIENTES ---
// ==================================================================
const CLIENTES = {
    "lavadora01": {
        dono: "Pedro",
        token_mp: "APP-USR-TOKEN-DO-PEDRO",
        sheet_id: "ID_DA_PLANILHA_DO_PEDRO" 
    },
    "lavadora02": {
        dono: "Joao",
        token_mp: "APP-USR-TOKEN-DO-JOAO",
        sheet_id: "ID-DA-PLANILHA-DO-JOAO"
    },
    "secadora01": {
        dono: "Joao",
        token_mp: "APP-USR-TOKEN-DO-JOAO",
        sheet_id: "ID-DA-PLANILHA-DO-JOAO"
    },
    "secadora02": {
        dono: "Maria",
        token_mp: "APP-USR-TOKEN-DA-MARIA",
        sheet_id: "ID-DA-PLANILHA-DA-MARIA"
    }
};

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
// --- 4. FUNÇÃO: BUSCAR PREÇO NA PLANILHA DO CLIENTE ---
// ==================================================================
async function buscarPrecoDinamico(idMaquina, tipoCiclo) {
    try {
        const dadosCliente = CLIENTES[idMaquina];
        if (!dadosCliente) return null;

        const doc = new GoogleSpreadsheet(dadosCliente.sheet_id, serviceAccountAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0]; 
        const rows = await sheet.getRows();

        let linha = rows.find(row => row.get('id_maquina') === idMaquina);
        if (!linha) {
             linha = rows.find(row => row.get('id_maquina') === 'padrao');
        }

        if (!linha) return null; 

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
// --- 5. ROTA: GERAR PAGAMENTO (CHECKOUT PRO) ---
// ==================================================================
app.post('/criar_pagamento', async (req, res) => {
    try {
        const { id_maquina, tempo } = req.body;
        
        // 1. Identifica o Cliente
        const dadosCliente = CLIENTES[id_maquina];
        if (!dadosCliente) return res.status(404).json({ error: "Máquina não cadastrada." });

        console.log(`Pedido para ${dadosCliente.dono} (Maq: ${id_maquina})`);

        // 2. Busca o preço na planilha DELE
        const valorFinal = await buscarPrecoDinamico(id_maquina, tempo);
        if (!valorFinal) return res.status(400).json({ error: "Erro de preço ou planilha inacessível." });

        console.log(`Preço definido pelo ${dadosCliente.dono}: R$ ${valorFinal}`);

        // 3. Cria a Preferência de Checkout no Mercado Pago (PIX + Cartões)
        const mpClient = new MercadoPagoConfig({ accessToken: dadosCliente.token_mp });
        const preference = new Preference(mpClient);

        // Gera o e-mail dinâmico para forçar o Mercado Pago a abrir PIX e Cartão
        const emailDinamico = `cliente_${Date.now()}@lavanderia.com`;

        const mpRes = await preference.create({
            body: {
                items: [
                    {
                        title: `Ciclo ${tempo}min - ${id_maquina}`,
                        quantity: 1,
                        unit_price: valorFinal
                    }
                ],
                payer: {
                    email: emailDinamico
                },
                payment_methods: {
                    excluded_payment_types: [
                        { id: "ticket" } // <-- ASSASSINA O BOLETO E LOTÉRICA
                    ],
                    installments: 1 // Força pagamento à vista
                },
                external_reference: `${id_maquina}|${tempo}`
            }
        });

        // Devolve o LINK da tela de pagamento para o celular do cliente
        res.json({
            status: "ok",
            valor: valorFinal,
            link_pagamento: mpRes.init_point
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
    const topic = req.query.topic || req.query.type;
    const id = req.query.id || req.query['data.id'];

    if ((topic === 'payment' || topic === 'merchant_order') && id) {
        
        // Varre os tokens cadastrados para achar de quem é o pagamento aprovado
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
                    break; // Achou o pagamento, para de procurar nos outros tokens
                }
            } catch (e) {
                // Erro silencioso: O pagamento não é deste cliente, tenta o próximo token
            }
        }
    }
    res.status(200).send("OK");
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
