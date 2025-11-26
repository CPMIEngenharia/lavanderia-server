require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const mqtt = require('mqtt');
const axios = require('axios');
const crypto = require('crypto'); // Adicionado para validação

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const payment = new Payment(client);

// --- MQTT (HiveMQ) ---
console.log('[SISTEMA] Conectando ao MQTT HiveMQ...');
let host = process.env.MQTT_HOST;
if (!host.startsWith('mqtts://') && !host.startsWith('mqtt://')) {
    host = `mqtts://${host}`;
}

const mqttClient = mqtt.connect(host, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASSWORD,
    port: 8883,
    protocol: 'mqtts',
    rejectUnauthorized: false
});

mqttClient.on('connect', () => console.log('[MQTT] Conectado com Sucesso!'));
mqttClient.on('error', (err) => console.error('[MQTT ERRO]', err.message));

// --- FUNÇÃO CSV ---
async function buscarConfiguracaoCSV(valorPago) {
    try {
        const url = process.env.SHEETS_URL;
        const response = await axios.get(url);
        const csvData = response.data;
        const linhas = csvData.split('\n');

        for (let i = 0; i < linhas.length; i++) {
            const colunas = linhas[i].split(',');
            if (colunas.length >= 3) {
                const valorPlanilhaString = colunas[0].replace('R$', '').replace(' ', '').trim();
                const valorPlanilha = parseFloat(valorPlanilhaString);
                if (Math.abs(valorPlanilha - valorPago) < 0.05) {
                    const tempo = parseInt(colunas[1].trim());
                    const ciclo = colunas[2].trim().replace(/[\r\n]+/g, '');
                    return { tempo, ciclo };
                }
            }
        }
        return null;
    } catch (e) {
        console.error('[ERRO CSV] Falha:', e.message);
        return null;
    }
}

// --- ROTA WEBHOOK COM VALIDAÇÃO DE ASSINATURA ---
app.post('/webhook', async (req, res) => {
    const { action, type, data } = req.body;
    const id = data?.id;

    // --- 1. VALIDAÇÃO DE SEGURANÇA (X-SIGNATURE) ---
    const signatureHeader = req.headers['x-signature'];
    const requestId = req.headers['x-request-id'];

    if (signatureHeader && requestId && process.env.MP_WEBHOOK_SECRET) {
        try {
            // Extrai ts e v1
            const parts = signatureHeader.split(',').reduce((acc, part) => {
                const [key, value] = part.split('=');
                acc[key.trim()] = value.trim();
                return acc;
            }, {});

            // Monta a string base: id:[data.id];request-id:[x-request-id];ts:[ts];
            const manifest = `id:${id};request-id:${requestId};ts:${parts.ts};`;

            // Cria o hash HMAC SHA256
            const hmac = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET);
            hmac.update(manifest);
            const sha = hmac.digest('hex');

            if (sha === parts.v1) {
                console.log('[SEGURANÇA] Assinatura válida! Processando...');
            } else {
                console.error('[SEGURANÇA] Assinatura INVÁLIDA. Hash não bate.');
                // Não bloqueamos totalmente agora para debug, mas avisamos no log
            }
        } catch (err) {
            console.error('[SEGURANÇA] Erro ao validar assinatura:', err.message);
        }
    } else {
        console.log('[SEGURANÇA] Aviso: Headers de assinatura ausentes ou Secret não configurado.');
    }

    // Responde OK para o Mercado Pago não tentar reenviar
    res.status(200).send('OK');

    // --- 2. LÓGICA DE NEGÓCIO ---
    if (id && (action === 'payment.created' || action === 'payment.updated' || type === 'payment')) {
        try {
            console.log(`[MP] Consultando Pagamento ID: ${id}...`);
            const pgto = await payment.get({ id: id });

            if (pgto.status === 'approved') {
                const valor = parseFloat(pgto.transaction_amount);
                console.log(`[VENDA] Aprovado: R$ ${valor}`);

                const config = await buscarConfiguracaoCSV(valor);

                if (config) {
                    console.log(`[DECISÃO] Ciclo: ${config.ciclo} (${config.tempo} min)`);
                    const payload = JSON.stringify({ ciclo: config.ciclo, tempo: config.tempo });
                    
                    if (mqttClient.connected) {
                        mqttClient.publish(process.env.MQTT_TOPIC_COMANDO, payload);
                        console.log(`[MQTT] Enviado: ${payload}`);
                    } else {
                        console.log('[ERRO] MQTT desconectado na hora H!');
                    }
                } else {
                    console.log(`[ERRO] Valor R$ ${valor} não encontrado na planilha.`);
                }
            } else {
                console.log(`[IGNORE] Status do pagamento: ${pgto.status}`);
            }
        } catch (error) {
            console.error('[ERRO INTERNO]', error.message);
        }
    }
});

app.get('/', (req, res) => res.send('<h1>Servidor Lavanderia Seguro</h1>'));
app.listen(PORT, () => console.log(`[START] Porta ${PORT}`));
