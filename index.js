require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const mqtt = require('mqtt');
const axios = require('axios'); 

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// --- CONFIGURAÇÕES ---
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const payment = new Payment(client);

// --- MQTT (HiveMQ) ---
console.log('[SISTEMA] Conectando ao MQTT HiveMQ...');

// Tratamento para garantir que o endereço tenha mqtts://
let host = process.env.MQTT_HOST;
if (!host.startsWith('mqtts://') && !host.startsWith('mqtt://')) {
    host = `mqtts://${host}`;
}

const mqttClient = mqtt.connect(host, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASSWORD,
    port: 8883,
    // ESSAS SÃO AS LINHAS MÁGICAS PARA O RENDER:
    protocol: 'mqtts',
    rejectUnauthorized: false // Permite conexão mesmo se o Render reclamar do certificado
});

mqttClient.on('connect', () => console.log('[MQTT] Conectado com Sucesso!'));
mqttClient.on('error', (err) => console.error('[MQTT ERRO]', err.message));

// --- FUNÇÃO: LER CSV DO GOOGLE SHEETS ---
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
        console.error('[ERRO CSV] Falha ao ler planilha:', e.message);
        return null;
    }
}

// --- ROTA WEBHOOK ---
app.post('/webhook', async (req, res) => {
    const { action, data } = req.body;
    res.status(200).send('OK');

    if (action === 'payment.created' || action === 'payment.updated') {
        try {
            const pgto = await payment.get({ id: data.id });
            
            if (pgto.status === 'approved') {
                const valor = parseFloat(pgto.transaction_amount);
                console.log(`[VENDA] Pagamento Aprovado: R$ ${valor}`);

                const config = await buscarConfiguracaoCSV(valor);

                if (config) {
                    console.log(`[DECISÃO] Valor R$ ${valor} = ${config.tempo} min (Ciclo: ${config.ciclo})`);
                    
                    const payload = JSON.stringify({ 
                        ciclo: config.ciclo, 
                        tempo: config.tempo 
                    });
                    
                    if (mqttClient.connected) {
                        mqttClient.publish(process.env.MQTT_TOPIC_COMANDO, payload);
                        console.log(`[MQTT] Comando enviado: ${payload}`);
                    } else {
                        console.log('[ERRO] MQTT desconectado na hora da venda!');
                    }
                } else {
                    console.log(`[ERRO] Valor R$ ${valor} não cadastrado.`);
                }
            }
        } catch (error) {
            console.error('[WEBHOOK ERROR]', error);
        }
    }
});

app.get('/', (req, res) => {
    res.send('<h1>Servidor Lavanderia Online (Fix MQTT)</h1>');
});

app.listen(PORT, () => {
    console.log(`[START] Servidor rodando na porta ${PORT}`);
});
