const express = require('express');
const axios = require('axios');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const PORTA = 3000;

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Conecta ao Turso na nuvem se configurado, senão usa arquivo local para testes
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:market.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function inicializarBanco() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS market_items (
            token_id TEXT PRIMARY KEY,
            name TEXT,
            category TEXT,
            raw_json TEXT,
            is_enriched INTEGER DEFAULT 0,
            sort_order INTEGER
        )
    `);

    await db.execute(`CREATE INDEX IF NOT EXISTS idx_category ON market_items(category)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_name ON market_items(name)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_enriched ON market_items(is_enriched)`);
}

let isSyncing = false;

async function enriquecerItem(item) {
    try {
        const respNft = await axios.get(`https://rola-nft-apis.maxion.gg/nft/${item.tokenId}`, { timeout: 4000 });
        const nftData = respNft.data;

        if (nftData) {
            const nomeReal = nftData.name_english || nftData.name || item.name;
            item.name = Array.isArray(nomeReal) ? nomeReal[0] : nomeReal;

            if (!item.attributes) item.attributes = {};

            if (nftData.enchantgrade !== undefined && nftData.enchantgrade !== null) {
                item.attributes.EnchantGrade = [parseInt(nftData.enchantgrade)];
            }
            if (nftData.refine && !item.attributes.Refine) item.attributes.Refine = [String(nftData.refine)];
            if (nftData.slots && !item.attributes["Card Slots"]) item.attributes["Card Slots"] = [String(nftData.slots)];

            item.nft_details = nftData;

            const nftId = nftData.nameid || item.tokenId;
            item.image = `https://cdn.maxion.gg/landverse/image-latam/collection/${nftId}.png`;

            if (!item.attributes["Item ID"]) {
                item.attributes["Item ID"] = [String(nftId)];
            }
        }
    } catch (err) {
        // Mantém básico se falhar
    }
    return item;
}

async function sincronizarComMaxion() {
    if (isSyncing) return;
    isSyncing = true;
    console.log('🔄 [Sync] Sincronizando catálogo com a Maxion...');

    let allResults = [];
    let totalNaApi = 0;
    let p = 0;
    const tamanhoLote = 50;

    try {
        do {
            const graphqlQuery = {
                query: `
                  query GetERC1155TokensList(
                    $tokenAddress: String
                    $slug: String
                    $criteria: [SearchCriteria!]
                    $from: Int!
                    $size: Int!
                    $sort: SortBy
                    $auctionType: AuctionType
                    $name: String
                    $rangeCriteria: [RangeSearchCriteria!]
                    $owner: String
                  ) {
                    erc1155Tokens(
                      tokenAddress: $tokenAddress
                      slug: $slug
                      criteria: $criteria
                      from: $from
                      size: $size
                      sort: $sort
                      auctionType: $auctionType
                      name: $name
                      rangeCriteria: $rangeCriteria
                      owner: $owner
                    ) {
                      total
                      results {
                        ...Erc1155TokenBrief
                        __typename
                      }
                      __typename
                    }
                  }

                  fragment Erc1155TokenBrief on Erc1155 {
                    tokenAddress
                    tokenId
                    slug
                    name
                    image
                    cdnImage
                    attributes
                    video
                    minPrice
                    totalItems
                    collectionMetadata
                    isLocked
                    badged
                    orders(from: 0, size: 1, showInvalid: false, sort: PriceAsc) {
                      ...OrderInfo
                    }
                  }

                  fragment OrderInfo on Order {
                    id
                    maker
                    kind
                    assets {
                      ...AssetInfo
                    }
                    expiredAt
                    paymentToken
                    startedAt
                    basePrice
                    expectedState
                    nonce
                    marketFeePercentage
                    signature
                    hash
                    duration
                    timeLeft
                    currentPrice
                    suggestedPrice
                    makerProfile {
                      ...PublicProfileBrief
                    }
                    orderStatus
                    orderQuantity {
                      orderId
                      quantity
                      remainingQuantity
                      availableQuantity
                    }
                  }

                  fragment AssetInfo on Asset {
                    erc
                    address
                    id
                    quantity
                    orderId
                  }

                  fragment PublicProfileBrief on PublicProfile {
                    accountId
                    addresses {
                      ...Addresses
                      __typename
                    }
                    activated
                    name
                  }

                  fragment Addresses on NetAddresses {
                    ethereum
                    ronin
                  }
                `,
                variables: {
                    from: p * tamanhoLote,
                    size: tamanhoLote,
                    tokenAddress: "0x04c868c3f9be43e4297386276609d355bf0fc861",
                    sort: "PriceAsc",
                    auctionType: "Sale"
                }
            };

            const resposta = await axios.post(
                'https://apps.maxion.gg/roverse-america/api/mavis/graphql',
                graphqlQuery,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Origin': 'https://apps.maxion.gg',
                        'Referer': 'https://apps.maxion.gg/roverse-america',
                        'User-Agent': 'Mozilla/5.0'
                    },
                    timeout: 15000
                }
            );

            const dadosApi = resposta.data?.data?.erc1155Tokens;
            const dados = dadosApi?.results || [];
            totalNaApi = dadosApi?.total || 0;

            if (dados.length === 0) break;
            allResults = allResults.concat(dados);
            p++;
        } while ((p * tamanhoLote) < totalNaApi && p < 60);

        if (allResults.length > 0) {
            const existingRows = await db.execute('SELECT token_id, is_enriched FROM market_items');
            const existingMap = new Map();
            existingRows.rows.forEach(row => existingMap.set(row.token_id, row.is_enriched));

            const currentActiveTokens = new Set(allResults.map(i => String(i.tokenId)));

            // Insere ou atualiza itens em lotes/transação simulada
            for (let index = 0; index < allResults.length; index++) {
                const item = allResults[index];
                const tokenIdStr = String(item.tokenId || `idx_${index}`);
                const attributes = item.attributes || {};
                const tipoItemArray = attributes.Type || [];
                const categoria = tipoItemArray.length > 0 ? tipoItemArray[0].toLowerCase() : 'etc';

                const jaExiste = existingMap.has(tokenIdStr);
                const statusEnriquecido = jaExiste ? existingMap.get(tokenIdStr) : 0;

                await db.execute({
                    sql: `
                        INSERT INTO market_items (token_id, name, category, raw_json, is_enriched, sort_order)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(token_id) DO UPDATE SET sort_order = ?
                    `,
                    args: [
                        tokenIdStr,
                        (item.name || '').toLowerCase(),
                        categoria,
                        JSON.stringify(item),
                        statusEnriquecido,
                        index,
                        index
                    ]
                });
            }

            // Remove tokens que expiraram / foram vendidos
            if (currentActiveTokens.size > 0) {
                const placeholders = Array.from(currentActiveTokens).map(() => '?').join(',');
                await db.execute({
                    sql: `DELETE FROM market_items WHERE token_id NOT IN (${placeholders})`,
                    args: Array.from(currentActiveTokens)
                });
            }

            console.log(`✅ [Sync] Sincronização concluída. Total: ${allResults.length}`);
            executarEnriquecimentoEmBackground();
        }
    } catch (err) {
        console.error('❌ [Sync] Erro:', err.message);
    } finally {
        isSyncing = false;
    }
}

async function executarEnriquecimentoEmBackground() {
    const res = await db.execute('SELECT token_id, raw_json FROM market_items WHERE is_enriched = 0 LIMIT 200');
    let pendentes = res.rows;

    while (pendentes.length > 0) {
        for (let row of pendentes) {
            let item = JSON.parse(row.raw_json);
            item = await enriquecerItem(item);

            await db.execute({
                sql: `
                    UPDATE market_items
                    SET name = ?, raw_json = ?, is_enriched = 1
                    WHERE token_id = ?
                `,
                args: [(item.name || '').toLowerCase(), JSON.stringify(item), row.token_id]
            });
        }
        const resNext = await db.execute('SELECT token_id, raw_json FROM market_items WHERE is_enriched = 0 LIMIT 200');
        pendentes = resNext.rows;
    }
}

app.get('/api/market/items', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 0;
        const size = parseInt(req.query.size) || 50;
        const categoria = (req.query.category || 'all').toLowerCase();
        const searchTerm = (req.query.name || '').toLowerCase().trim();

        let conditions = [];
        let params = [];

        if (categoria !== 'all' && categoria !== 'favorite' && categoria !== 'interested') {
            conditions.push('category = ?');
            params.push(categoria);
        }

        if (searchTerm !== '') {
            conditions.push('name LIKE ?');
            params.push(`%${searchTerm}%`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countRes = await db.execute({
            sql: `SELECT COUNT(*) as total FROM market_items ${whereClause}`,
            args: params
        });
        const total = Number(countRes.rows[0].total);

        const offset = page * size;
        const dataRes = await db.execute({
            sql: `
                SELECT token_id, raw_json, is_enriched FROM market_items
                ${whereClause}
                ORDER BY sort_order ASC
                LIMIT ? OFFSET ?
            `,
            args: [...params, size, offset]
        });

        let results = [];
        for (let row of dataRes.rows) {
            let item = JSON.parse(row.raw_json);
            if (row.is_enriched === 0) {
                item = await enriquecerItem(item);
                await db.execute({
                    sql: `
                        UPDATE market_items
                        SET name = ?, raw_json = ?, is_enriched = 1
                        WHERE token_id = ?
                    `,
                    args: [(item.name || '').toLowerCase(), JSON.stringify(item), row.token_id]
                });
            }
            results.push(item);
        }

        res.json({ total: total, results: results });
    } catch (erro) {
        console.error('Erro:', erro.message);
        res.status(500).json({ erro: 'Erro interno' });
    }
});

app.listen(PORTA, async () => {
    await inicializarBanco();
    console.log(`🚀 Servidor rodando em: http://localhost:${PORTA}`);
    await sincronizarComMaxion();
});
