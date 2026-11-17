const axios = require('axios');

async function buscarItem() {
  try {
    console.log('Buscando dados do NFT 84464 na API do Landverse America...');

    const resposta = await axios.get('https://rola-nft-apis.maxion.gg/nft/84464');

    console.log('Sucesso! Dados recebidos:');
    console.log(resposta.data);
  } catch (erro) {
    console.error('Ocorreu um erro ao buscar:', erro.message);
  }
}

buscarItem();
