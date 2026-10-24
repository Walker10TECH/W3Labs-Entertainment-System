# Arquitetura — W3Labs Entertainment System

## 1. Visão de camadas

```text
┌────────────────────────────────────────────────────────────────────┐
│ Renderer (sandbox, contextIsolation, sem Node)                     │
│ HTML/CSS/JS · biblioteca · BIOS · controles · RA · configurações    │
└───────────────────────────────┬────────────────────────────────────┘
                                │ window.w3 (métodos nomeados)
┌───────────────────────────────▼────────────────────────────────────┐
│ Preload isolado                                                    │
│ contextBridge + ipcRenderer.invoke / eventos allowlist             │
└───────────────────────────────┬────────────────────────────────────┘
                                │ IPC assíncrono
┌───────────────────────────────▼────────────────────────────────────┐
│ Main process (Node.js)                                             │
│ IPC handlers · serviços · SQLite WAL · criptografia · logs          │
│                                                                    │
│  ┌───────────────┐  ┌────────────────┐  ┌───────────────────────┐  │
│  │ Library/Bios  │  │ Metadata/RA    │  │ EmulationService      │  │
│  │ SaveStates    │  │ Controllers    │  │ HardwareService       │  │
│  └───────┬───────┘  └────────────────┘  └──────────┬────────────┘  │
└──────────┼─────────────────────────────────────────┼───────────────┘
           │                                         │ fork + IPC
           ▼                                         ▼
┌──────────────────────┐                  ┌──────────────────────────┐
│ SQLite (WAL)         │                  │ core-host (processo      │
│ games/bios/saves/... │                  │ filho isolado)           │
└──────────────────────┘                  │  ├─ núcleo externo       │
                                          │  └─ bridge JSON Lines    │
                                          └──────────────────────────┘
```

O renderer nunca recebe `fs`, `child_process`, `require` ou caminhos arbitrários. Todos os acessos passam pelo contrato IPC.

## 2. Processos e isolamento

| Processo         | Responsabilidade                                        | Falha isolada?         |
| ---------------- | ------------------------------------------------------- | ---------------------- |
| Main             | Janela, IPC, banco, serviços, rate limit                | —                      |
| Renderer         | UI                                                      | Sim (reload da janela) |
| `core-host`      | Validação de mídia, spawn do núcleo, comandos de estado | Sim                    |
| Emulador externo | Emulação real                                           | Sim                    |
| Bridge           | Controle de estado/pausa                                | Sim                    |

`CoreManager` usa `child_process.fork` com `ELECTRON_RUN_AS_NODE=1` e um protocolo de mensagens:

```text
parent                       core-host                    bridge
  │ fork ──────────────────────▶│                          │
  │ init {rom, bios, stateDir} ▶│                          │
  │                             │ spawn(bridge) ──────────▶│
  │                             │◀─ {id:"init", ok:true} ──│
  │◀───── ready {pid, caps} ────│                          │
  │ request save-state ────────▶│ request save-state ─────▶│
  │                             │◀──── {id, ok:true} ──────│
  │◀──── response + stat ───────│                          │
  │ request shutdown ──────────▶│ quit ───────────────────▶│
  │◀──── exit ──────────────────│                          │
```

O `stateDir` é validado em ambos os lados. O `core-host` só aceita `statePath` dentro do diretório da sessão e com nome `[slot].state`.

## 3. Fluxo de inicialização

```text
app.whenReady
  ├─ createRuntimeConfig()          → dataRoot, paths, limites
  ├─ Logger
  ├─ AppDatabase                    → PRAGMA WAL + migrations + seed
  ├─ CryptoVault                    → chave AES local
  ├─ Services (BIOS, library, RA…)
  ├─ registerCoverProtocol()        → w3cover://cover/:gameId
  ├─ registerIpcHandlers()          → contrato + trusted sender
  ├─ createMainWindow()
  └─ forwardEvents()                → emulation/RA/bios/scan
```

Meta de boot da UI: < 4 s em SSD. O carregamento inicial usa consultas preparadas e não varre arquivos.

## 4. Fluxo de escaneamento

```text
addRoot(path)
  ├─ realpath + isDirectory
  ├─ proíbe pastas internas (saves/data)
  └─ insere library_roots

scanAll()
  ├─ walkFiles: opendir assíncrono, sem symlinks
  ├─ plataforma por extensão, dica da raiz ou detector de ISO
  ├─ .iso ambíguo: PS3_DISC.SFB / XEX2 / XBOX_DVD / BOOT2 / pasta / tamanho
  ├─ se path + size + mtime inalterados → marca visto e corrige plataforma
  ├─ senão hashFile(sha1, md5) em stream de 1 MiB + progresso em bytes
  ├─ upsert games ON CONFLICT(file_path)
  ├─ arquivos ausentes → is_missing = 1 (linha preservada)
  └─ progresso throttle 150 ms → IPC event
```

Arquivos > 2 GB passam pelo mesmo stream: **não há `readFile` de mídia**. No launch, `MediaLoader.inspect()` faz `stat` + leitura de 64 KiB de cabeçalho e devolve `readStrategy: "stream-on-disk"`; o `core-host` lê apenas 16 bytes adicionais e entrega o caminho ao núcleo. `MediaLoader.openStream()` existe para leitores que precisem de faixas específicas do disco.

## 5. BIOS

Estados:

```text
arquivo escolhido
  ├─ stat/tamanho
  ├─ MD5 + SHA-1 em stream
  ├─ lookup no catálogo por MD5
  │    ├─ presente → plataforma/região/kind do catálogo
  │    └─ ausente → fluxo de BIOS personalizada
  │         ├─ usuário atesta plataforma/região/tipo
  │         ├─ regra de tamanho da plataforma
  │         ├─ is_custom = 1, verification_method = user-attested-hash
  │         └─ sem catálogo global; hash local revalidado a cada boot
  ├─ tamanho exato + SHA-1 opcional
  ├─ cópia para data/bios/<plataforma>/
  └─ INSERT bios_files(status='valid')
```

A importação automática recusa hash desconhecido (`BIOS_HASH_NOT_RECOGNIZED`) sem copiar o arquivo. A BIOS personalizada exige atestação explícita, valida tamanho (PS1 512 KB, PS2 4 MB, Xbox 512 B/256 KB/1 MB, GB 256 B/2.304 B) e grava os hashes calculados no banco. Ela não ganha uma identidade de catálogo; a região é declarada pelo usuário e o arquivo é revalidado antes de cada boot.

Antes de cada boot, `BiosService.resolveForGame()`:

1. exige região para plataformas com BIOS obrigatória;
2. busca `platform_id`, `kind` e `(region = game.region OR region = 'global')`;
3. recalcula MD5/SHA-1;
4. em divergência, grava `status='invalid'` e recusa o launch.

Xbox exige os kinds `bootrom` + `flash`. PS1/PS2 exigem `bios`. PS3/GB/Xbox 360 não exigem BIOS pelo gate (Xenia usa HLE e arquivos de conteúdo específicos).

## 6. Save States e Hardcore

Caminho canônico:

```text
<dataRoot>/saves/<platform_id>/<sha1_da_rom>/<slot>.state
```

Exemplo:

```text
./saves/ps2/5f83ab…c91/0.state
```

Ordem de guardas em `SaveStateService.save/load`:

```text
1. RA Hardcore ativo?            → HARDCORE_LOCKED
2. Existe sessão ativa do jogo?  → GAME_NOT_ACTIVE
3. Slot inteiro 0..99?           → INVALID_SAVE_SLOT
4. Boot guard da BIOS expirou?   → BOOT_GUARD_ACTIVE
5. Núcleo tem capability?        → CORE_STATE_UNSUPPORTED
6. Caminho calculado e validado  → STATE_PATH_OUTSIDE
7. bridge grava/lê
8. Hardcore foi ativado durante? → apaga estado recém-criado
```

Hardcore é persistido em `settings` e verificado dinamicamente. A UI é apenas reflexo; a decisão é sempre do backend.

## 7. Playtime

`EmulationService` mantém a sessão em memória e grava a cada 15 s:

```sql
UPDATE play_sessions SET duration_seconds = duration_seconds + ? WHERE id = ?;
UPDATE games SET playtime_seconds = playtime_seconds + ? WHERE id = ?;
```

Pausa interrompe o acúmulo. O stop faz flush final. A janela Electron não bloqueia a contagem porque o emulador externo fica em outra janela; o estado de referência é “processo do núcleo ativo e não pausado”.

## 8. Metadados e rate limit

`MetadataService` compartilha um único `RateLimiter` entre ScreenScraper, IGDB, autenticação e download de capa:

```text
maxRequests = 50
windowMs = 60.000
minIntervalMs = 1.200
```

A fila serializa chamadas; nenhuma rajada de 50 simultâneas. Cache em SQLite por `provider:platform:sha1` com TTL de 14 dias. Capas são baixadas somente de hosts allowlisted via HTTPS e salvas com nome derivado do ID do jogo.

### Instaladores automáticos

`EmulatorInstaller` baixa as releases oficiais de PCSX2, RPCS3, xemu e Xenia Canary via GitHub API, verifica SHA-256 (asset `digest` ou `.sha256` sidecar) quando disponível, valida caminhos do archive com `tar -tf` e extrai com `tar -xf` em um diretório de staging. O staging é promovido atomicamente para `<data>/cores/<coreId>`, com `manifest.json` contendo versão, executável relativo e hash. `CoreRegistry` lê esse manifesto depois de procurar caminhos do sistema, então a instalação passa a valer sem reiniciar.

O fluxo é Windows x64 nesta versão. A interface mostra progresso, fonte oficial e permite atualizar. Nenhum BIOS/firmware/jogo é baixado.

### Diagnóstico de GPU

`HardwareService` combina `app.getGPUInfo('basic')`, nomes e vendor IDs PCI. O “Microsoft Basic Render Driver” (`0x1414`/5140) é tratado como fallback do Windows e ignorado quando há GPU real (AMD `0x1002`, NVIDIA `0x10de`, Intel `0x8086`). Isso evita o falso positivo em máquinas como AMD RX590 + fallback WARP. O aviso só aparece quando não há GPU de hardware, o renderer é realmente software ou a RAM é inferior a 8 GB; o usuário sempre pode prosseguir.

## 9. Controles

Perfis físicos exigem GUID no formato UUID:

```text
xinput|directinput + hardware_guid válido → perfil aceito
GUID ausente/malformado                  → CONTROLLER_GUID_INVALID
GUID já vinculado                        → CONTROLLER_ALREADY_BOUND
teclado                                  → KEYBOARD_GUID fixo, sem validação de hardware
```

O Chromium reporta `Gamepad.id`, não o GUID estável de DirectInput. A UI mostra o dispositivo como “GUID ausente” e não permite o vínculo. Um provider nativo (SDL/HID) pode preencher o GUID no mesmo contrato.

## 10. IPC — contrato

Todos os handlers retornam:

```js
{ ok: true, data: ... }
{ ok: false, error: { code, message, details? } }
```

| Canal                                              | Entrada                                         | Saída                                          |
| -------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `app:info`                                         | —                                               | versão, plataformas, settings, cores, caminhos |
| `app:stats`                                        | —                                               | totais, recentes, matriz BIOS                  |
| `library:list`                                     | `{search, platformId, favorite, limit, offset}` | jogos                                          |
| `library:pickRoot` / `addRoot`                     | caminho escolhido no dialog                     | raiz                                           |
| `library:scan`                                     | —                                               | sumário + eventos `library:scan-progress`      |
| `library:favorite/region/platform/remove`          | id/valor                                        | jogo atualizado ou confirmação                 |
| `bios:chooseAndImport`                             | `platformHint?`                                 | BIOS catalogada                                |
| `bios:chooseAndImportCustom`                       | plataforma/região/kind/label/atestado           | BIOS personalizada com hash local              |
| `bios:list/matrix/remove`                          | — / id                                          | estado de BIOS                                 |
| `emulation:launch`                                 | `gameId, {acknowledgedWarnings}`                | sessão + hardware                              |
| `emulation:pause/resume/stop`                      | —                                               | sessão                                         |
| `saves:list/save/load/remove`                      | `gameId, slot`                                  | save state                                     |
| `controllers:inspect`                              | `gamepads[]`, `platformId`                      | diagnóstico GUID                               |
| `controllers:saveProfile/setMapping/removeProfile` | perfil/id                                       | perfil                                         |
| `ra:connect/status/refresh/disconnect`             | credenciais                                     | status                                         |
| `ra:hardcore`                                      | boolean                                         | status (bloqueia saves)                        |
| `ra:linkGame/syncAchievements`                     | IDs                                             | resultado                                      |
| `metadata:scrape`                                  | `gameId`                                        | provedor/cache                                 |
| `settings:getAll/set/reset`                        | chave/valor                                     | settings                                       |
| `hardware:info/assess`                             | plataforma                                      | aviso confirmável                              |
| `cores:installCatalog/install`                     | coreId                                          | instalação automática + eventos de progresso   |
| `cores:openSite`                                   | coreId                                          | abre a fonte oficial no navegador              |

Eventos allowlisted: `library:scan-progress`, `emulation:changed`, `emulation:core-event`, `ra:changed`, `bios:changed`, `cores:install-progress`, `cores:changed`.

## 11. Segurança

- `BrowserWindow`: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- `will-navigate` bloqueado; `window.open` negado; permissões de sessão negadas.
- CSP sem `connect-src`, permitindo imagens locais e avatares do RA.
- Protocolo `w3cover` resolve a capa por ID, nunca por caminho do renderer.
- `assertTrusted` exige o `webContents.id` da janela principal e URL `file://`.
- Segredos em AES-256-GCM, chave em `data/secret.key` (modo 0600).
- Argumentos de processos são arrays, `shell: false`; nunca há concatenação de shell.
- Logs não incluem chaves de API; erros IPC são sanitizados.

## 12. Próximas fases

1. Provider nativo SDL para GUID de DirectInput e mapeamento por botão.
2. Bridge de referência para libretro/RetroArch com save state e pausa.
3. Tracker RA via rcheevos/memory watcher.
4. Captura de screenshot/gravação de vídeo e memory cards virtuais.
5. OTA com electron-updater, assinatura de código e testes em macOS/Linux.
6. Medição do instalador e redução de artefatos Electron.
