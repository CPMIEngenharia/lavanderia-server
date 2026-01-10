/*
 * SERVIDOR LAVANDERIA IOT - VERSÃO MULTI-CLIENTE (V2)
 * Funcionalidade: Recebe pedidos de várias máquinas e direciona
 * o pagamento para a conta do Mercado Pago do dono específico.
 */

const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const mqtt = require('mqtt');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// --- 1. CONFIGURAÇÃO MQTT (Seu HiveMQ) ---
const MQTT_URL = "mqtts://d54e131cfd444c24b4775af5044e1a33.s1.eu.hivemq.cloud:8883";
const MQTT_USER = "servidorlv_nodejs";
const MQTT_PASS = "Lave2025";

const mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    rejectUnauthorized: false // Para aceitar o certificado do HiveMQ
});

mqttClient.on('connect', () => {
    console.log("CONECTADO AO MQTT (HIVEMQ)!");
});

// ==================================================================
// --- 2. CADASTRO DE MÁQUINAS E DONOS (Sua "Agenda") ---
// ==================================================================
// Aqui você cola o Access Token que o cliente te mandar no WhatsApp.
// O ID da máquina (ex: maquina01) deve ser o mesmo que está no código do ESP32.

const CLIENTES = {
    // [SUA MÁQUINA DE TESTE]
    "maquina01": "APP-USR-SEU-TOKEN-AQUI", 

    // [CLIENTE JOÃO - LAVADORA]
    "lavadora01": "APP-USR-TOKEN-DO-JOAO-AQUI",

    // [CLIENTE JOÃO - SECADORA]
    "secadora01": "APP-USR-TOKEN-DO-JOAO-AQUI", 

    // [CLIENTE MARIA]
    "lavadora02": "APP-USR-TOKEN-DA-MARIA-AQUI"
};

// ==================================================================

// --- ROTA 1: GERAR O PIX (Chamada pelo App ou QR Code) ---
app.post('/criar_pagamento', async (req, res) => {
    try {
        // O Front-end/QR Code deve enviar: { id_maquina: "lavadora01", valor: 10.00, tempo: 45 }
        const { id_maquina, valor, tempo } = req.body;

        console.log(`Novo Pedido: Máquina ${id_maquina} - R$ ${valor}`);

        // 1. Busca o Token do Dono
        const tokenDoDono = CLIENTES[id_maquina];

        if (!tokenDoDono) {
            return res.status(400).json({ error: "Máquina não cadastrada ou Token inválido." });
        }

        // 2. Configura o Mercado Pago com a conta DELE
        const client = new MercadoPagoConfig({ accessToken: tokenDoDono });
        const payment = new Payment(client);

        // 3. Cria a Preferência de Pagamento
        const result = await payment.create({
            body: {
                transaction_amount: parseFloat(valor),
                description: `Ciclo Lavanderia - ${id_maquina}`,
                payment_method_id: 'pix',
                payer: {
                    email: 'cliente@email.com' // Pode ser genérico
                },
                // O SEGREDO ESTÁ AQUI: "external_reference" guarda os dados para o Webhook
                // Guardamos o ID da máquina e o tempo (ex: "lavadora01|45")
                external_reference: `${id_maquina}|${tempo}` 
            }
        });

        // 4. Devolve o Copia e Cola e o QR Code Base64
        const qrCode = result.point_of_interaction.transaction_data.qr_code;
        const qrCodeBase64 = result.point_of_interaction.transaction_data.qr_code_base64;
        const paymentId = result.id;

        res.json({
            status: "ok",
            qr_code: qrCode,
            qr_base64: qrCodeBase64,
            payment_id: paymentId
        });

    } catch (error) {
        console.error("Erro ao gerar Pix:", error);
        res.status(500).json({ error: "Erro interno ao gerar pagamento" });
    }
});

// --- ROTA 2: WEBHOOK (O Mercado Pago avisa aqui quando pagarem) ---
app.post('/webhook', async (req, res) => {
    const topic = req.query.topic || req.query.type;
    const id = req.query.id || req.query['data.id'];

    if (topic === 'payment') {
        try {
            console.log(`Pagamento recebido! ID: ${id}`);
            
            // Aqui precisamos descobrir de QUEM foi esse pagamento.
            // O jeito certo seria consultar o pagamento na API para ver o "external_reference".
            // Mas como não sabemos qual Token usar (pode ser qualquer cliente),
            // precisamos de uma estratégia.
            
            // ESTRATÉGIA SIMPLIFICADA PARA MP ATUAL:
            // O MP manda o ID. Infelizmente, para consultar o status "approved",
            // precisamos tentar os tokens até achar (ou salvar o ID no banco na hora da criação).
            
            // --- SOLUÇÃO ROBUSTA (CONSULTA EM TODOS OS TOKENS) ---
            let pagamentoInfo = null;
            let maquinaAlvo = "";
            let tempoAlvo = "";

            // Varre a lista de clientes para achar quem recebeu esse pagamento
            for (const [keyMaq, token] of Object.entries(CLIENTES)) {
                try {
                    const client = new MercadoPagoConfig({ accessToken: token });
                    const payment = new Payment(client);
                    const dados = await payment.get({ id: id });
                    
                    if (dados && dados.status === 'approved') {
                        pagamentoInfo = dados;
                        console.log(`Pagamento encontrado na conta da máquina: ${keyMaq}`);
                        break; // Achou! Para de procurar.
                    }
                } catch (e) {
                    // Ignora erro (significa que o pagamento não é desse token)
                }
            }

            if (pagamentoInfo) {
                // Recupera os dados que escondemos no external_reference
                // Formato: "lavadora01|45"
                const ref = pagamentoInfo.external_reference.split('|');
                maquinaAlvo = ref[0];
                tempoAlvo = ref[1];

                console.log(`LIBERANDO MÁQUINA: ${maquinaAlvo} por ${tempoAlvo} min`);

                // --- COMANDO MQTT ---
                const topicoComando = `lavanderia/${maquinaAlvo}/comandos`;
                const mensagem = JSON.stringify({ tempo: tempoAlvo }); // ex: {"tempo": 45} ou {"tempo": "secar"}

                mqttClient.publish(topicoComando, mensagem);
                console.log(`Comando enviado para ${topicoComando}`);
            }

        } catch (error) {
            console.error("Erro no Webhook:", error);
        }
    }

    res.status(200).send("OK");
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
