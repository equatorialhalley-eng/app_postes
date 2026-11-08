# Inventário Inteligente de Postes — v0

PWA de campo para o inventário fotográfico exigido pela **NT.00016.EQTL**.
Identifica o poste por **posição + rumo** (GPS e bússola), não por imagem.

## O que faz

- Ranqueia os **3 postes candidatos** mais prováveis e mostra os atributos que desambiguam
  (altura, esforço, material, BT/MT, ocupantes declarados no GEOSWEB, irregularidades).
- Captura as **duas fotos** da NT (aberta + detalhe da ocupação), com **tarja gravada na
  imagem**: poste, OS, projeto, município, data/hora, coordenada, precisão e azimute.
- Nomeia cada foto no padrão do dossiê: `<OS>_<ID>_<BARRAMENTO>_A|D.jpg` — a pasta sai
  pronta para o gerador, sem casamento manual de foto com poste.
- Avalia a **nitidez** no ato (variância de Laplaciano) e alerta sobre foto borrada.
- Confere os **ocupantes**: mostra o que o GEOSWEB declara, recebe a contagem de campo e
  marca **divergência** — o dado do dossiê continua sendo o derivado da Planilha Detalhada.
- Funciona **100 % offline** (service worker + IndexedDB) e exporta o **ZIP** do inventário.
- Registra, em `ranking.csv`, **em que posição da lista estava o poste confirmado** — é o
  número que valida ou derruba o conceito de identificação por posição.

## Hospedagem (obrigatória: precisa ser HTTPS)

Câmera, GPS e bússola só funcionam em origem segura. Abrir o arquivo direto do celular
(`file://`) **não funciona**. Três caminhos:

**GitHub Pages — 10 minutos, grátis**
1. Crie um repositório (pode ser privado em conta paga, público nos demais).
2. Suba os 6 arquivos na raiz: `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`,
   `icon-192.png`, `icon-512.png`.
3. Settings → Pages → Branch `main` / pasta `/ (root)` → Save.
4. Em 1–2 minutos sai o endereço `https://<usuario>.github.io/<repo>/`.

**Servidor da PRODEPA / Halley** — copie os 6 arquivos para qualquer diretório servido por
HTTPS. Não precisa de backend, banco nem build.

**Teste local no computador** — `python3 -m http.server 8080` e abra `http://localhost:8080`
(localhost conta como origem segura; o celular na mesma rede, porém, precisa de HTTPS).

## Instalar no celular

Abrir o endereço no Chrome (Android) ou Safari (iOS) → menu → **Adicionar à tela de início**.
A partir daí abre em tela cheia e funciona sem rede.

No iPhone, a bússola exige toque em **"Ativar bússola"** no cabeçalho (exigência do iOS).
Sem bússola o app ordena só por distância e avisa na tela.

## Carregar o pacote de campo

Aba **Projeto** → *Importar CSV / KML*. Aceita:

- o `_enriquecido.csv` do `enriquecer_postes_bdgd.py`;
- a exportação do GEOSWEB salva como CSV;
- KML com `Placemark`/`Point` (atributos em `ExtendedData` são lidos).

Reconhece cabeçalho com e sem acento, separador `;` ou `,`, vírgula decimal e recupera
coordenada estragada pelo Excel (`-24.215.556` → `-2,4215556`).

Em **Calibração**, informe o deslocamento sistemático GEOSWEB→campo do município
(Tomé-Açu: +2,1 E / −1,95 N · Canaã: +1,00 E / −4,94 N).

## Limites conhecidos desta v0

- Sem mapa de fundo: o mini-mapa é esquemático (postes, raio de precisão, cone de rumo).
  Tiles offline do corredor ficam para a v1.
- Sem sincronização automática: a entrega é o ZIP, gerado ao fim do dia. O backend com
  fila de envio e gravação no Drive é a etapa seguinte.
- Coordenada e azimute vão na tarja da imagem e no manifesto, ainda não no EXIF.
- Dados ficam **só neste aparelho**. **Exporte ao fim de cada dia de campo.**
