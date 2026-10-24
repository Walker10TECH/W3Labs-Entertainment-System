# Tipografia

A interface usa, nesta ordem:

1. **Nokia Pure Headline**, quando a fonte licenciada está instalada no sistema operacional.
2. **Manrope** (SIL Open Font License), empacotada localmente como fallback.

A Nokia Pure é uma fonte proprietária da Nokia/Monotype. O projeto **não redistribui** os arquivos da Nokia. O CSS usa `local("Nokia Pure Headline")`; se você possui a licença e instalar a fonte no Windows, ela é aplicada automaticamente.

## Para usar a Nokia Pure Headline

1. Adquira a licença pelos canais oficiais da Nokia/Monotype.
2. Instale a fonte no Windows (clique com o botão direito no `.ttf`/`.otf` → **Instalar**).
3. Reinicie o Electron.

## Fallback Manrope

Os arquivos `Manrope-latin.woff2` e `Manrope-latin-ext.woff2` estão em `src/renderer/assets/fonts/`, junto do texto da licença `OFL-Manrope.txt`. A licença permite redistribuição e incorporação.

Se a Nokia Pure não estiver instalada, a interface continua com Manrope, sem requisições de rede.
