require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const mqtt = require('mqtt');
const axios = require('axios'); 

const app = express();
// O Render define a porta automaticamente, mas deixamos 3000 como fallback
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// --- CONFIGURAÇÕES ---
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const payment = new Payment(client);

// --- MQTT (HiveMQ) ---
console.log('[SISTEMA] Conectando ao MQTT HiveMQ...');
const mqttClient = mqtt.connect(process.env.MQTT_HOST, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASSWORD,
    protocol: 'mqtts', 
    port: 8883
});

mqttClient.on('connect', () => console.log('[MQTT] Conectado com Sucesso!'));

// --- FUNÇÃO: LER CSV DO GOOGLE SHEETS ---
async function buscarConfiguracaoCSV(valorPago) {
    try {
        const url = process.env.SHEETS_URL;
        const response = await axios.get(url);
        const csvData = response.data;
        
        // Quebra o CSV em linhas
        const linhas = csvData.split('\n');

        // Percorre as linhas procurando o preço
        for (let i = 0; i < linhas.length; i++) {
            const colunas = linhas[i].split(',');
            
            // Espera: Coluna A (Valor) | Coluna B (Tempo) | Coluna C (Ciclo)
            if (colunas.length >= 3) {
                // Limpa o valor da planilha (tira R$, espaços, etc)
                const valorPlanilhaString = colunas[0].replace('R$', '').replace(' ', '').trim();
                const valorPlanilha = parseFloat(valorPlanilhaString);

                // Compara com margem de erro de 5 centavos (segurança para float)
                if (Math.abs(valorPlanilha - valorPago) < 0.05) {
                    
                    const tempo = parseInt(colunas[1].trim());
                    // Remove quebras de linha invisíveis (\r) que o Windows/Excel cria
                    const ciclo = colunas[2].trim().replace(/[\r\n]+/g, ''); 

                    return { tempo, ciclo };
                }
            }
        }
        return null; // Não achou preço correspondente

    } catch (e) {
        console.error('[ERRO CSV] Falha ao ler planilha:', e.message);
        return null;
    }
}

// --- ROTA WEBHOOK (MERCADO PAGO) ---
app.post('/webhook', async (req, res) => {
    const { action, data } = req.body;
    
    // Responde OK imediatamente para o Mercado Pago não ficar reenviando
    res.status(200).send('OK');

    if (action === 'payment.created' || action === 'payment.updated') {
        try {
            // Consulta a API oficial para confirmar status 'approved'
            const pgto = await payment.get({ id: data.id });
            
            if (pgto.status === 'approved') {
                const valor = parseFloat(pgto.transaction_amount);
                console.log(`[VENDA] Pagamento Aprovado: R$ ${valor}`);

                // 1. Busca qual ciclo liberar na Planilha
                const config = await buscarConfiguracaoCSV(valor);

                if (config) {
                    console.log(`[DECISÃO] Valor R$ ${valor} = ${config.tempo} min (Ciclo: ${config.ciclo})`);
                    
                    // 2. Monta o pacote JSON para o ESP32
                    const payload = JSON.stringify({ 
                        ciclo: config.ciclo, 
                        tempo: config.tempo 
                    });
                    
                    // 3. Envia via MQTT
                    const topico = process.env.MQTT_TOPIC_COMANDO;
                    mqttClient.publish(topico, payload);
                    console.log(`[MQTT] Comando enviado para ${topico}: ${payload}`);
                } else {
                    console.log(`[ERRO] Valor R$ ${valor} não encontrado na tabela de preços.`);
                }
            }
        } catch (error) {
            console.error('[WEBHOOK ERROR]', error);
        }
    }
});

// --- ROTA DE STATUS (Para o Render saber que está vivo) ---
app.get('/', (req, res) => {
    res.send('<h1>Servidor Lavanderia Online (Modo CSV)</h1>');
});

app.listen(PORT, () => {
    console.log(`[START] Servidor rodando na porta ${PORT}`);
});
