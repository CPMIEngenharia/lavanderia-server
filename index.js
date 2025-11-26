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

// URL do seu servidor (o Render preenche automaticamente ou usamos fixo)
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

        // Percorre a planilha (Valor | Tempo | Ciclo)
        for (let i = 0; i < linhas.length; i++) {
            const colunas = linhas[i].split(',');
            if (colunas.length >= 3) {
                // Coluna B é o Tempo
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

// --- ROTA 1: CRIAR PAGAMENTO (O Cliente acessa via QR Code da Máquina) ---
// Exemplo de link: https://seu-servidor.onrender.com/comprar/maquina01/15
app.get('/comprar/:maquinaid/:tempo', async (req, res) => {
    const { maquinaid, tempo } = req.params;

    // 1. Busca o preço na planilha para esse tempo
    const dados = await buscarPrecoPorTempo(tempo);

    if (!dados) {
        return res.send(`<h1>Erro</h1><p>Tempo de ${tempo} min não encontrado na tabela de preços.</p>`);
    }

    console.log(`[NOVO PEDIDO] ${maquinaid} | ${tempo} min | R$ ${dados.preco}`);

    try {
        // 2. Cria a Preferência no Mercado Pago (O Segredo do Sucesso)
        const preferenceData = {
            items: [
                {
                    id: `lavagem-${tempo}`,
                    title: `Lavanderia: Ciclo ${dados.ciclo} (${tempo} min)`,
                    quantity: 1,
                    currency_id: 'BRL',
                    unit_price: dados.preco
                }
            ],
            // AQUI ESTÁ A MÁGICA: Guardamos o comando na "external_reference"
            external_reference: `${maquinaid}-${tempo}`,
            notification_url: `${SERVER_URL}/webhook`,
            auto_return: 'approved',
            back_urls: {
                success: 'https://www.google.com', // Pode mudar para uma pagina de "Obrigado"
                failure: 'https://www.google.com',
                pending: 'https://www.google.com'
            }
        };

        const preference = await mpPreference.create({ body: preferenceData });
        
        // 3. Redireciona o cliente para o Pagamento
        res.redirect(preference.init_point);

    } catch (error) {
        console.error('[ERRO PREFERENCE]', error);
        res.status(500).send('Erro ao gerar pagamento.');
    }
});

// --- ROTA 2: WEBHOOK (Recebe a confirmação) ---
app.post('/webhook', async (req, res) => {
    const { action, type, data } = req.body;
    const id = data?.id;

    res.status(200).send('OK');

    if (id && (action === 'payment.created' || action === 'payment.updated' || type === 'payment')) {
        try {
            const pgto = await mpPayment.get({ id: id });

            if (pgto.status === 'approved') {
                // AQUI LEMOS O CARIMBO QUE CRIAMOS LÁ EM CIMA
                const referencia = pgto.external_reference; // Ex: maquina01-15
                console.log(`[PAGAMENTO APROVADO] Ref: ${referencia}`);

                if (referencia && referencia.includes('-')) {
                    const [maquina, tempoString] = referencia.split('-');
                    const tempo = parseInt(tempoString);

                    // Envia MQTT
                    const payload = JSON.stringify({ ciclo: "AUTO", tempo: tempo }); // Ciclo AUTO pois o Arduino decide baseado no tempo
                    
                    if (mqttClient.connected) {
                        mqttClient.publish(process.env.MQTT_TOPIC_COMANDO, payload);
                        console.log(`[MQTT] Comando enviado: ${payload}`);
                    }
                }
            }
        } catch (error) {
            console.error('[ERRO WEBHOOK]', error);
        }
    }
});

app.get('/', (req, res) => res.send('<h1>Lavanderia V2 (Modo Preferência)</h1>'));
app.listen(PORT, () => console.log(`[START] Porta ${PORT}`));
