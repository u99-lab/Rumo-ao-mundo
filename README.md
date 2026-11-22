# Atlas de Portugal

Atlas interativo com vista de distritos, concelhos e freguesias.

## Publicação no Render

Este repositório está preparado como site estático através do ficheiro `render.yaml`.

No Render, criar um **Blueprint** e escolher este repositório:
- Repositório: `u99-lab/Rumo-ao-mundo`
- Ramo: `main`
- Ficheiro de configuração: `render.yaml`

O Render publica a pasta principal do repositório. O site usa `index.html` e `app.js` e consulta os dados cartográficos através do serviço CAOP/LNEG.

## Notas
- A página depende de ligação à Internet para carregar MapLibre e os dados cartográficos.
- Os PDFs de impressão são ficheiros separados e ainda não estão incluídos neste site.
