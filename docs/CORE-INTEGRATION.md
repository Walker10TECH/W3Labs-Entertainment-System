# Integração dos núcleos

O W3Labs é um **orquestrador**. Os emuladores são binários externos instalados pelo usuário; BIOS e ROMs não acompanham o projeto.

## 1. Configuração

No primeiro boot, `config/cores.example.json` é copiado para `data/cores.json` (ou `<userData>/data/cores.json`). Edite os caminhos:

```json
{
  "cores": {
    "pcsx2": {
      "label": "PCSX2",
      "executable": "C:\\Program Files\\PCSX2\\pcsx2-qt.exe",
      "args": ["-fullscreen", "-batch", "--", "{rom}"],
      "bridgeCommand": null,
      "capabilities": {
        "pause": false,
        "saveState": false,
        "loadState": false,
        "screenshot": false
      },
      "biosKind": "directory"
    }
  }
}
```

Placeholders aceitos:

| Token             | Valor                                |
| ----------------- | ------------------------------------ |
| `{rom}`           | caminho absoluto da ROM/ISO          |
| `{stateDir}`      | `<saves>/<plataforma>/<sha1>`        |
| `{slot}`          | slot solicitado                      |
| `{platform}`      | id da plataforma                     |
| `{gameId}`        | UUID interno                         |
| `{biosDir}`       | diretório da primeira BIOS resolvida |
| `{bios:bootrom}`  | caminho do MCPX (Xbox)               |
| `{bios:flash}`    | caminho do BIOS flash (Xbox)         |
| `{bios:bios}`     | caminho da BIOS PS1/PS2              |
| `{bios:firmware}` | firmware PS3, quando catalogado      |

A descoberta também procura caminhos padrão em `Program Files`, `LOCALAPPDATA`, `/usr/bin`, `/Applications` e aceita:

```text
W3_CORE_DUCKSTATION=...
W3_CORE_PCSX2=...
W3_CORE_MESEN=...
W3_CORE_XEMU=...
W3_CORE_RPCS3=...
W3_CORE_SAMEBOY=...
```

## 2. Modo externo (fallback)

Sem `bridgeCommand`, o `core-host` abre o executável com `spawn` e mantém o processo filho isolado. O jogo abre, mas:

- pausar/retomar via UI fica indisponível;
- save/load state fica indisponível;
- a UI informa a limitação e o backend recusa o comando com `CORE_STATE_UNSUPPORTED`.

Isso evita gravar um arquivo `.state` falso ou fingir que o emulador salvou.

## 3. Modo bridge (Save/Load State gerenciável)

Adicione `bridgeCommand` e habilite as capabilities:

```json
{
  "cores": {
    "meu-core": {
      "label": "Core gerenciado",
      "executable": "C:\\MeusNucleos\\core.exe",
      "args": ["--rom", "{rom}"],
      "bridgeCommand": ["node", "C:\\MeusNucleos\\bridge.js"],
      "capabilities": {
        "pause": true,
        "saveState": true,
        "loadState": true,
        "screenshot": true
      }
    }
  }
}
```

O `bridgeCommand` é iniciado pelo `core-host`; ele deve falar **JSON Lines** no stdin/stdout. Mensagens fora do protocolo podem ir para stderr.

### Inicialização

Parent → bridge:

```json
{
  "id": "init",
  "command": "init",
  "payload": {
    "sessionId": "uuid",
    "platformId": "ps2",
    "gameId": "uuid",
    "romPath": "D:\\Games\\game.iso",
    "stateDir": "...\\saves\\ps2\\sha1",
    "biosFiles": [{ "kind": "bios", "path": "..." }],
    "fullscreen": true
  }
}
```

Bridge → parent (uma das formas):

```json
{ "id": "init", "ok": true, "data": { "ready": true } }
{ "event": "ready" }
```

### Save state

Parent → bridge:

```json
{
  "id": "req-uuid",
  "command": "save-state",
  "path": "…\\saves\\ps2\\<sha1>\\3.state",
  "slot": 3
}
```

Bridge → parent:

```json
{ "id": "req-uuid", "ok": true, "data": { "saved": true } }
```

O `core-host` valida que `path` está dentro de `stateDir` e tem o nome `3.state`; depois confirma que o arquivo existe e tem tamanho > 0.

### Load state

```json
{ "id": "req-uuid", "command": "load-state", "path": "…\\3.state", "slot": 3 }
```

### Pausa / retomada

```json
{ "id": "req-uuid", "command": "pause" }
{ "id": "req-uuid", "command": "resume" }
```

### Encerramento

```json
{ "id": "shutdown", "command": "quit" }
```

O bridge deve encerrar em até 2,5 s; depois o `core-host` aplica `SIGKILL` e encerra a sessão.

### Eventos

O bridge pode emitir eventos assíncronos:

```json
{ "event": "achievement", "data": { ... } }
{ "event": "state-error", "data": { "message": "..." } }
```

Eles chegam ao renderer como `emulation:core-event`.

## 4. BIOS e staging

O orquestrador valida a BIOS importada, mas emuladores externos têm seus próprios diretórios de configuração. Para PS1/PS2:

- configure o emulador para usar o mesmo arquivo importado; ou
- use um bridge que receba `biosFiles` no `init` e faça o staging no diretório `system` do núcleo.

xemu recebe `{bios:bootrom}` e `{bios:flash}` diretamente nos argumentos. PS3/RPCS3 pode usar o firmware instalado no próprio RPCS3; o W3Labs não bloqueia PS3 por firmware (a regra de BIOS obrigatória cobre PS1/PS2/Xbox).

## 5. Requisitos de hardware

Antes do launch de PS2/Xbox/PS3, `HardwareService` consulta `app.getGPUInfo('basic')`. Se não houver GPU dedicada, VRAM adequada ou RAM mínima, o backend retorna `HARDWARE_WARNING` com detalhes. A UI mostra um diálogo e o usuário pode confirmar `acknowledgedWarnings: true`; isso cumpre “avisar, mas permitir continuar por conta e risco”.

## 6. Contrato de testes

`tests/fixtures/fake-bridge.js` implementa o protocolo mínimo e é usado por `tests/core-manager.test.js` para provar:

- fork real do `core-host` (PID diferente);
- init + ready;
- save state no caminho validado;
- pause/resume;
- load state;
- bloqueio de path fora do diretório;
- shutdown sem processo órfão.

Para integrar um emulador real, o bridge deve produzir estado nativo do núcleo — nunca um placeholder.
