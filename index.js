require('dotenv').config();
const express = require('express');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const mqtt = require('mqtt');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- CONFIGURAÇÕES ---
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const mpPayment = new Payment(client);
const mpPreference = new Preference(client);

// URL do Servidor
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;

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

// --- FUNÇÃO: BUSCAR PREÇO POR TEMPO (CSV) ---
async function buscarPrecoPorTempo(tempoDesejado) {
    try {
        const url = process.env.SHEETS_URL;
        const response = await axios.get(url);
        const linhas = response.data.split('\n');

        for (let i = 0; i < linhas.length; i++) {
            const colunas = linhas[i].split(',');
            if (colunas.length >= 3) {
                const tempoPlanilha = parseInt(colunas[1].trim());
                if (tempoPlanilha == tempoDesejado) {
                    const precoString = colunas[0].replace('R$', '').replace(' ', '').trim();
                    return {
                        preco: parseFloat(precoString),
                        ciclo: colunas[2].trim().replace(/[\r\n]+/g, '')
                    };
                }
            }
        }
        return null;
    } catch (e) {
        console.error('[ERRO CSV]', e.message);
        return null;
    }
}

// --- ROTA DE COMPRA (Dinâmica para qualquer máquina) ---
// Exemplo: /comprar/lavadora01/15 ou /comprar/secadora04/45
app.get('/comprar/:maquinaid/:tempo', async (req, res) => {
    const { maquinaid, tempo } = req.params;

    const dados = await buscarPrecoPorTempo(tempo);
    if (!dados) return res.send(`<h1>Erro</h1><p>Tempo ${tempo} min não cadastrado.</p>`);

    console.log(`[NOVO PEDIDO] ${maquinaid} | ${tempo} min | R$ ${dados.preco}`);

    try {
        const preferenceData = {
            items: [
                {
                    id: `ciclo-${tempo}`,
                    title: `Ciclo ${dados.ciclo} (${tempo} min) - ${maquinaid.toUpperCase()}`,
                    quantity: 1,
                    currency_id: 'BRL',
                    unit_price: dados.preco
                }
            ],
            // REFERÊNCIA EXTERNA: Guarda quem é a máquina (ex: lavadora01-15)
            external_reference: `${maquinaid}-${tempo}`,
            notification_url: `${SERVER_URL}/webhook`,
            auto_return: 'approved',
            back_urls: {
                success: 'https://www.google.com', 
                failure: 'https://www.google.com',
                pending: 'https://www.google.com'
            }
        };

        const preference = await mpPreference.create({ body: preferenceData });
        res.redirect(preference.init_point);

    } catch (error) {
        console.error('[ERRO PREFERENCE]', error);
        res.status(500).send('Erro ao gerar pagamento.');
    }
});

// --- WEBHOOK (Roteador Central) ---
app.post('/webhook', async (req, res) => {
    const { action, type, data } = req.body;
    const id = data?.id;

    res.status(200).send('OK');

    if (id && (action === 'payment.created' || action === 'payment.updated' || type === 'payment')) {
        try {
            const pgto = await mpPayment.get({ id: id });

            if (pgto.status === 'approved') {
                const referencia = pgto.external_reference; // Ex: lavadora03-15
                console.log(`[PAGAMENTO APROVADO] Ref: ${referencia}`);

                if (referencia && referencia.includes('-')) {
                    // SEPARA O ID DA MÁQUINA DO TEMPO
                    const [maquinaId, tempoString] = referencia.split('-');
                    const tempo = parseInt(tempoString);

                    // Cria o Tópico Específico: lavanderia/lavadora03/comandos
                    const topicoAlvo = `lavanderia/${maquinaId}/comandos`;
                    
                    const payload = JSON.stringify({ ciclo: "AUTO", tempo: tempo });
                    
                    if (mqttClient.connected) {
                        mqttClient.publish(topicoAlvo, payload);
                        console.log(`[MQTT] Enviado para [${topicoAlvo}]: ${payload}`);
                    }
                }
            }
        } catch (error) {
            console.error('[ERRO WEBHOOK]', error);
        }
    }
});

app.get('/', (req, res) => res.send('<h1>Sistema Multi-Máquinas Online</h1>'));
app.listen(PORT, () => console.log(`[START] Porta ${PORT}`));
