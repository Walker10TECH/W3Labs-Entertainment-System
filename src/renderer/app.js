'use strict';

const api = window.w3;

if (!api) {
  document.body.innerHTML = '<p style="padding:40px;color:#fff">Ponte IPC indisponível.</p>';
  throw new Error('Preload não carregado.');
}

const state = {
  view: 'library',
  info: null,
  platforms: [],
  games: [],
  roots: [],
  stats: null,
  bios: [],
  matrix: [],
  profiles: [],
  detected: null,
  ra: null,
  metadata: null,
  active: null,
  cores: [],
  installCatalog: [],
  installProgress: {},
  installingCores: [],
  settings: {},
  filters: { search: '', platform: null },
  loading: true,
  scan: null,
  modal: null,
  pendingLaunch: null,
  confirmResolve: null,
  busy: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const viewRoot = $('#view');

const VIEW_META = {
  library: { title: 'Biblioteca', eyebrow: 'Coleção unificada' },
  bios: { title: 'BIOS & Firmware', eyebrow: 'Integridade e região' },
  controllers: { title: 'Controles', eyebrow: 'XInput · DirectInput' },
  achievements: { title: 'Conquistas', eyebrow: 'RetroAchievements' },
  settings: { title: 'Configurações', eyebrow: 'Sistema e núcleos' },
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function platformOf(id) {
  return (
    state.platforms.find((platform) => platform.id === id) ?? {
      id,
      shortName: String(id).toUpperCase(),
      color: '#d4ff5f',
      name: id,
    }
  );
}

function initials(title) {
  return String(title ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function formatPlaytime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return total > 0 ? `${total}s` : 'Não jogado';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '—';
  }
}

function biosReadyCount() {
  return state.bios.filter((entry) => entry.status === 'valid').length;
}

function toast(message, { title = 'W3Labs', type = 'info', timeout = 4200 } = {}) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `
    <div>
      <strong>${esc(title)}</strong>
      <p>${esc(message)}</p>
    </div>
    <button type="button" aria-label="Fechar">×</button>
  `;
  node.querySelector('button').addEventListener('click', () => node.remove());
  $('#toastRoot').append(node);
  window.setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateX(10px)';
    window.setTimeout(() => node.remove(), 180);
  }, timeout);
}

function handleError(error, fallbackTitle = 'Não foi possível concluir') {
  if (error?.code === 'HARDWARE_WARNING') {
    showHardwareWarning(error);
    return;
  }
  if (error?.code === 'BIOS_REQUIRED' || error?.code === 'BIOS_REGION_REQUIRED') {
    toast(error.message, { title: 'BIOS necessária', type: 'warn', timeout: 6500 });
    return;
  }
  if (error?.code === 'CORE_NOT_INSTALLED') {
    const coreId = error.details?.coreId;
    if (coreId) {
      openCoreInstallModal(coreId, error.message);
      return;
    }
    toast(`${error.message} Abra Configurações para revisar os núcleos.`, {
      title: 'Núcleo não encontrado',
      type: 'warn',
      timeout: 7000,
    });
    return;
  }
  toast(error?.message ?? 'Erro inesperado.', { title: fallbackTitle, type: 'error' });
}

async function loadInitial() {
  try {
    const info = await api.app.info();
    state.info = info;
    state.platforms = info.platforms ?? [];
    state.settings = info.settings ?? {};
    state.cores = info.cores ?? [];
    const results = await Promise.allSettled([
      api.app.stats(),
      api.library.list({ limit: 300 }),
      api.library.roots(),
      api.bios.list(),
      api.bios.matrix(),
      api.controllers.profiles(),
      api.retroachievements.status(),
      api.metadata.status(),
      api.emulation.active(),
      api.cores.installCatalog(),
    ]);
    const value = (index, fallback) =>
      results[index].status === 'fulfilled' ? results[index].value : fallback;
    state.stats = value(0, { games: 0, playtimeSeconds: 0, platforms: [] });
    state.games = value(1, []);
    state.roots = value(2, []);
    state.bios = value(3, []);
    state.matrix = value(4, []);
    state.profiles = value(5, []);
    state.ra = value(6, { connected: false, hardcore: false });
    state.metadata = value(7, null);
    state.active = value(8, null);
    state.installCatalog = value(9, []);
    state.loading = false;
    syncShell();
    renderView();
    startLiveClock();
  } catch (error) {
    state.loading = false;
    viewRoot.innerHTML = `
      <div class="empty-state" style="grid-template-columns:1fr">
        <div class="empty-copy">
          <div class="empty-icon">${icon('info')}</div>
          <h2>Não foi possível iniciar o aplicativo</h2>
          <p>${esc(error.message)}</p>
          <button class="btn btn-primary" data-action="reload">Tentar novamente</button>
        </div>
      </div>`;
  }
}

function syncShell() {
  $('#navGameCount').textContent = String(state.stats?.games ?? state.games.length ?? 0);
  $('#navBiosDot').hidden = !state.matrix.some((entry) => entry.required && !entry.ready);
  const hardcore = Boolean(state.ra?.hardcore);
  $('#navHardcore').hidden = !hardcore;
  $('#hardcoreSideText').textContent = hardcore ? 'Ativo · saves bloqueados' : 'Desativado';
  $('#hardcoreSwitch').closest('.hardcore-card').classList.toggle('is-active', hardcore);
  $('#sidebarHardcore').setAttribute('aria-pressed', String(hardcore));
  $('#raTopName').textContent = state.ra?.connected ? state.ra.username : 'RetroAchievements';
  $('#raTopState').textContent = state.ra?.connected
    ? hardcore
      ? 'Hardcore ativo'
      : `${state.ra.profile?.points ?? 0} pontos`
    : 'não conectado';
  if (state.ra?.connected) {
    const avatar = state.ra.profile?.avatar;
    $('#raAvatar').innerHTML = avatar
      ? `<img src="${esc(avatar)}" alt="">`
      : esc(
          String(state.ra.username ?? 'W3')
            .slice(0, 2)
            .toUpperCase(),
        );
  } else {
    $('#raAvatar').textContent = 'W3';
  }
  $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.nav === state.view));
  const meta = VIEW_META[state.view];
  $('#topbarTitle').textContent = meta.title;
  $('#topbarEyebrow').textContent = meta.eyebrow;
  document.title = `${meta.title} · W3Labs Entertainment System`;
  renderActiveStrip();
}

function renderActiveStrip() {
  const strip = $('#activeStrip');
  if (!state.active) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  const active = state.active;
  strip.hidden = false;
  strip.innerHTML = `
    <span class="live-dot"></span>
    <strong>${esc(active.gameTitle)}</strong>
    <span>${esc(active.platformName)} · ${esc(active.coreLabel)} · ${formatPlaytime(active.playtimeSeconds)}</span>
    <span class="strip-spacer"></span>
    <button type="button" data-action="open-active-game">Abrir sessão</button>
    <button type="button" data-action="stop-session">${icon('stop')} Encerrar</button>
  `;
}

function renderView() {
  syncShell();
  if (state.loading) return;
  const scrollTop = viewRoot.scrollTop;
  const renderers = {
    library: renderLibrary,
    bios: renderBios,
    controllers: renderControllers,
    achievements: renderAchievements,
    settings: renderSettings,
  };
  try {
    viewRoot.innerHTML = renderers[state.view]();
    viewRoot.scrollTop = scrollTop;
  } catch (error) {
    viewRoot.innerHTML = `<div class="empty-inline">Falha ao renderizar: ${esc(error.message)}</div>`;
  }
}

function consoleTiles() {
  return state.platforms
    .map(
      (platform) => `
      <div class="console-tile" style="--tile:${esc(platform.color)}" title="${esc(platform.name)}">
        <i></i><span>${esc(platform.shortName)}</span>
      </div>`,
    )
    .join('');
}

function renderLibrary() {
  const games = state.games;
  const hasRoots = state.roots.length > 0;
  const totalPlatforms = new Set(games.map((game) => game.platformId)).size;
  const filterPlatforms = state.platforms.filter((platform) =>
    (state.stats?.platforms ?? []).some((entry) => entry.platformId === platform.id),
  );
  const stats = state.stats ?? { games: 0, playtimeSeconds: 0 };
  const readyBios = biosReadyCount();

  const hero = `
    <section class="hero">
      <div class="hero-copy">
        <span class="hero-badge">${icon('database')} Sete sistemas · uma biblioteca</span>
        <h2>Seu acervo clássico,<br>sob controle.</h2>
        <p>PS1, PS2, NES, Xbox, Xbox 360, PS3 e Game Boy em uma única biblioteca local. BIOS validadas por hash, núcleos pesados isolados e seus saves sempre organizados.</p>
        <div class="hero-actions">
          <button class="btn btn-primary" data-action="add-root">${icon('plus')} Adicionar pasta</button>
          <button class="btn" data-action="scan" ${hasRoots ? '' : 'disabled'}>${icon('refresh')} Escanear acervo</button>
        </div>
      </div>
      <div class="console-rail" aria-hidden="true">${consoleTiles()}</div>
    </section>`;

  const statsGrid = `
    <div class="stats-grid">
      <div class="stat"><span>Jogos indexados</span><strong>${stats.games ?? games.length}</strong><small>locais</small></div>
      <div class="stat"><span>Plataformas ativas</span><strong>${totalPlatforms}</strong><small>de ${state.platforms.length}</small></div>
      <div class="stat"><span>Tempo de jogo</span><strong>${formatPlaytime(stats.playtimeSeconds)}</strong></div>
      <div class="stat"><span>BIOS validadas</span><strong>${readyBios}</strong><small>revisadas por hash</small></div>
    </div>`;

  if (!hasRoots && games.length === 0) {
    return `
      ${hero}
      <div class="empty-state">
        <div class="empty-copy">
          <div class="empty-icon">${icon('folder')}</div>
          <h2>Comece pela sua própria coleção.</h2>
          <p>O W3Labs não fornece ROMs, ISOs ou BIOS. Aponte uma pasta com os arquivos que você já possui; o scanner calcula hashes em streaming, sem carregar mídias grandes na memória.</p>
          <button class="btn btn-primary" data-action="add-root">${icon('plus')} Escolher pasta de jogos</button>
          <div class="console-chips">
            ${state.platforms.map((platform) => `<span class="console-chip">${esc(platform.shortName)}</span>`).join('')}
          </div>
        </div>
        <div class="empty-steps">
          <h3>Como funciona</h3>
          <div class="step"><b>1</b><div><strong>Adicione sua pasta</strong><span>O scanner reconhece extensões de cada console.</span></div></div>
          <div class="step"><b>2</b><div><strong>Valide as BIOS</strong><span>PS1, PS2 e Xbox exigem BIOS por região.</span></div></div>
          <div class="step"><b>3</b><div><strong>Jogue com isolamento</strong><span>PS2, Xbox, Xbox 360 e PS3 rodam em processos segregados.</span></div></div>
          <div class="step"><b>4</b><div><strong>Opcional: metadados</strong><span>Capas e sinopses via APIs com limite de 50 req/min.</span></div></div>
        </div>
      </div>`;
  }

  const filterChips = `
    <div class="filter-row">
      <button class="filter-chip ${state.filters.platform === null ? 'is-active' : ''}" data-action="filter-platform" data-platform="">Todas <span class="dot"></span></button>
      ${filterPlatforms
        .map(
          (platform) => `
        <button class="filter-chip ${state.filters.platform === platform.id ? 'is-active' : ''}"
          data-action="filter-platform" data-platform="${esc(platform.id)}">
          <span class="dot" style="background:${esc(platform.color)}"></span>${esc(platform.shortName)}
        </button>`,
        )
        .join('')}
    </div>`;

  const grid = games.length
    ? `<div class="game-grid">${games.map(gameCard).join('')}</div>`
    : `<div class="empty-inline">Nenhum jogo encontrado${state.filters.search ? ` para “${esc(state.filters.search)}”` : ''}. Execute um novo escaneamento ou ajuste os filtros.</div>`;

  return `
    ${hero}
    ${statsGrid}
    <div class="section-head">
      <div>
        <h3>Sua biblioteca</h3>
        <p>${games.length} título${games.length === 1 ? '' : 's'} ${state.filters.search ? 'no filtro atual' : 'disponíveis'} · ordenados por favoritos</p>
      </div>
      <button class="btn btn-ghost btn-sm" data-action="scan">${icon('refresh')} Atualizar</button>
    </div>
    ${filterChips}
    ${grid}
  `;
}

function gameCard(game, index = 0) {
  const platform = platformOf(game.platformId);
  return `
    <button type="button" class="game-card" data-action="open-game" data-game="${esc(game.id)}"
      style="--platform-color:${esc(platform.color)};animation-delay:${Math.min(index * 18, 220)}ms">
      <div class="game-cover">
        ${game.coverUrl ? `<img src="${esc(game.coverUrl)}" alt="" loading="lazy">` : ''}
        <span class="cover-monogram">${esc(initials(game.title))}</span>
        <span class="platform-badge">${esc(platform.shortName)}</span>
        <span class="favorite-mark ${game.favorite ? 'is-on' : ''}">${icon('star')}</span>
        <span class="game-hover"><span>${formatPlaytime(game.playtimeSeconds)}</span><span class="play-dot">${icon('play')}</span></span>
      </div>
      <div class="game-meta">
        <strong>${esc(game.title)}</strong>
        <span>${esc(game.regionLabel ?? 'Região ?')}<i></i>${esc(game.genre || platform.name)}</span>
      </div>
    </button>`;
}

function renderBios() {
  const matrix = state.matrix;
  const missingRequired = matrix.filter((entry) => entry.required && !entry.ready).length;
  const cards = matrix
    .map((entry) => {
      const platform = platformOf(entry.platformId);
      const status = entry.ready
        ? entry.installedCount > 0
          ? '<span class="status-pill ok">Pronta</span>'
          : entry.required
            ? '<span class="status-pill bad">Pendente</span>'
            : '<span class="status-pill warn">Opcional</span>'
        : '<span class="status-pill bad">Pendente</span>';
      return `
        <article class="bios-card" style="--platform-color:${esc(platform.color)}">
          <div class="bios-card-head">
            <div class="bios-platform-icon">${esc(platform.shortName)}</div>
            <div>
              <strong>${esc(entry.fullName)}</strong>
              <span>${entry.required ? 'BIOS obrigatória por região' : entry.recommended ? 'Firmware recomendado' : 'Boot ROM opcional'}</span>
            </div>
            ${status}
          </div>
          <div class="region-row">
            ${
              entry.regions.length
                ? entry.regions
                    .map(
                      (region) => `<span class="region-chip ${region.installed ? 'has' : ''}">
                        <span class="mini-dot"></span>${esc(region.label)} · ${region.installed}
                      </span>`,
                    )
                    .join('')
                : '<span class="region-chip">Sem região aplicável</span>'
            }
          </div>
          <div class="kind-row">
            ${entry.kinds.map((kind) => `<span class="kind-tag">${esc(kind)}</span>`).join('')}
            <button class="btn btn-sm" style="margin-left:auto" data-action="import-bios" data-platform="${esc(entry.platformId)}">${icon('plus')} Importar</button>
          </div>
        </article>`;
    })
    .join('');

  const rows = state.bios
    .map(
      (bios) => `
      <tr>
        <td><strong>${esc(bios.label)}</strong> ${bios.isCustom ? '<span class="custom-tag">personalizada</span>' : ''}<br><span class="hash">${esc(bios.fileName)}</span></td>
        <td>${esc(bios.platformName)}</td>
        <td>${esc(bios.regionLabel)}</td>
        <td><span class="kind-tag">${esc(bios.kind)}</span></td>
        <td>${formatBytes(bios.sizeBytes)}</td>
        <td><span class="hash">${esc(bios.md5)}</span></td>
        <td><span class="status-pill ${bios.status === 'valid' ? 'ok' : 'bad'}">${esc(bios.status)}</span></td>
        <td><div class="table-actions"><button class="ghost-icon" data-action="delete-bios" data-id="${esc(bios.id)}" title="Remover">${icon('trash')}</button></div></td>
      </tr>`,
    )
    .join('');

  return `
    <div class="page-head">
      <div>
        <span class="eyebrow">Segurança por fingerprint</span>
        <h1>BIOS &amp; Firmware</h1>
        <p>MD5 e SHA-1 são calculados na importação e revalidados antes de cada boot.</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="open-settings">${icon('settings')} Núcleos</button>
        <button class="btn" data-action="import-custom-bios">${icon('edit')} BIOS personalizada</button>
        <button class="btn btn-primary" data-action="import-bios">${icon('plus')} Importar BIOS</button>
      </div>
    </div>

    <div class="legal-note">
      ${icon('info')}
      <div>
        <strong>O aplicativo não fornece nem baixa BIOS.</strong>
        <p>Importe apenas arquivos extraídos do seu próprio hardware ou de fontes que você tenha direito de usar. BIOS fora do catálogo podem ser registradas como <b>personalizadas</b>, com atestação explícita e hashes calculados localmente.</p>
      </div>
    </div>

    <div class="section-head">
      <div><h3>Requisitos por plataforma</h3><p>${missingRequired ? `${missingRequired} plataforma(s) com pendência` : 'Todas as plataformas obrigatórias estão prontas'}</p></div>
    </div>
    <div class="bios-grid">${cards}</div>

    <div class="section-head">
      <div><h3>Arquivos validados</h3><p>${state.bios.length} impressão(ões) digital(is) no banco local</p></div>
    </div>
    ${
      state.bios.length
        ? `<div class="table-wrap"><table class="data-table">
            <thead><tr><th>Arquivo</th><th>Plataforma</th><th>Região</th><th>Tipo</th><th>Tamanho</th><th>MD5</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`
        : `<div class="empty-inline">Nenhuma BIOS importada. Jogos de PS1, PS2 e Xbox permanecerão bloqueados até a validação.</div>`
    }
  `;
}

function renderControllers() {
  const profiles = state.profiles;
  const detected = state.detected;
  const devices = detected?.devices ?? [];
  return `
    <div class="page-head">
      <div>
        <span class="eyebrow">Hardware de entrada</span>
        <h1>Controles</h1>
        <p>Perfis de jogador 1–4, compatíveis com XInput, DirectInput e teclado.</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="create-keyboard">${icon('plus')} Perfil de teclado</button>
        <button class="btn btn-primary" data-action="detect-controllers">${icon('refresh')} Detectar controles</button>
      </div>
    </div>

    <div class="legal-note">
      ${icon('hardcore')}
      <div>
        <strong>Regra de GUID de hardware</strong>
        <p>Um controle físico só é vinculado a um jogador quando o sistema operacional reporta um GUID válido. Um ID amigável do Chromium não é suficiente; o backend rejeita GUIDs ausentes, malformados ou já vinculados.</p>
      </div>
    </div>

    <div class="controller-layout">
      <div class="panel">
        <div class="panel-head">
          <div><h3>Dispositivos detectados</h3><p>${detected ? `${devices.length} dispositivo(s) no último diagnóstico` : 'Execute a detecção para consultar o Gamepad API'}</p></div>
          ${detected ? `<span class="status-pill ${devices.some((device) => device.bindable) ? 'ok' : 'warn'}">${devices.filter((device) => device.bindable).length} vinculável(is)</span>` : ''}
        </div>
        <div class="panel-body">
          ${
            devices.length
              ? `<div class="device-list">${devices
                  .map(
                    (device) => `
                  <div class="device">
                    <span class="device-icon">${icon('controller')}</span>
                    <div>
                      <strong>${esc(device.id)}</strong>
                      <span>${esc(device.mapping)} · ${device.buttons} botões · ${device.axes} eixos</span>
                    </div>
                    ${
                      device.bindable
                        ? `<button class="btn btn-sm btn-primary" data-action="bind-controller" data-index="${device.index}">Vincular</button>`
                        : '<span class="status-pill warn">GUID ausente</span>'
                    }
                  </div>`,
                  )
                  .join('')}</div>`
              : `<div class="empty-inline">${detected ? 'Nenhum controle reportado pelo sistema no momento.' : 'Clique em “Detectar controles”. O Chromium costuma expor o dispositivo sem GUID; nesse caso, o vínculo permanece bloqueado por segurança.'}</div>`
          }
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div><h3>Perfis de jogador</h3><p>Máximo de quatro perfis</p></div><span class="status-pill">${profiles.length}/4</span></div>
        <div class="panel-body">
          ${
            profiles.length
              ? profiles
                  .map(
                    (profile) => `
                <div class="profile-card">
                  <div class="profile-head">
                    <span class="player-badge">P${profile.playerIndex}</span>
                    <div><strong>${esc(profile.name)}</strong><br><span>${esc(profile.api.toUpperCase())}</span></div>
                    <button class="ghost-icon" data-action="delete-profile" data-id="${esc(profile.id)}" title="Remover">${icon('trash')}</button>
                  </div>
                  <div class="guid-text">${esc(profile.hardwareGuid)}</div>
                  <div class="profile-actions">
                    <button class="btn btn-sm" data-action="edit-mapping" data-id="${esc(profile.id)}">${icon('edit')} Mapeamento</button>
                  </div>
                </div>`,
                  )
                  .join('')
              : '<div class="empty-inline">Nenhum perfil. Crie um perfil de teclado ou vincule um controle com GUID validado.</div>'
          }
        </div>
      </div>
    </div>

    <div class="panel mt-16">
      <div class="panel-body" style="color:var(--muted);font-size:10px;line-height:1.6">
        ${icon('info')} <strong style="color:var(--text)">Sobre o bridge de entrada:</strong>
        o renderer usa o Gamepad API apenas para diagnóstico. Para que XInput/DirectInput exponha o GUID estável do hardware,
        conecte um provider nativo de SDL/HID ao backend. Sem GUID reportado, nenhum perfil físico é criado.
      </div>
    </div>
  `;
}

function renderAchievements() {
  const ra = state.ra ?? { connected: false, hardcore: false };
  if (!ra.connected) {
    return `
      <div class="page-head">
        <div>
          <span class="eyebrow">Conquistas e histórico</span>
          <h1>RetroAchievements</h1>
          <p>Conecte sua conta para acompanhar pontos e travar Save States no modo Hardcore.</p>
        </div>
      </div>
      <div class="ra-hero">
        <div class="ra-hero-main">
          <div class="ra-mark">${icon('trophy')}</div>
          <h2>Conecte sua conta.</h2>
          <p>O sistema valida as credenciais diretamente na API do RetroAchievements e armazena a Web API Key cifrada em AES-256-GCM. Nenhuma credencial é enviada a terceiros pelo W3Labs.</p>
          <form id="raConnectForm" class="form-grid" style="max-width:400px">
            <div class="field">
              <label for="raUsername">Usuário</label>
              <input id="raUsername" name="username" autocomplete="username" placeholder="seu_usuario" required>
            </div>
            <div class="field">
              <label for="raApiKey">Web API Key</label>
              <input id="raApiKey" name="apiKey" type="password" autocomplete="off" placeholder="chave de 32 caracteres" required>
              <small>Disponível nas configurações do seu perfil em retroachievements.org. A chave fica cifrada localmente.</small>
            </div>
            <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('hardcore')} Conectar conta</button></div>
          </form>
        </div>
        <div class="ra-side">
          <h3>O que é validado</h3>
          <div class="step"><b>1</b><div><strong>Conexão ativa</strong><span>Hardcore só pode ser ativado com a API online.</span></div></div>
          <div class="step"><b>2</b><div><strong>Trava imediata</strong><span>Ao ativar Hardcore, Save/Load State são bloqueados no backend e na UI.</span></div></div>
          <div class="step"><b>3</b><div><strong>Sem atalhos</strong><span>Nenhuma criação, sobrescrita ou carregamento de estado é permitido.</span></div></div>
        </div>
      </div>`;
  }

  const profile = ra.profile ?? {};
  return `
    <div class="page-head">
      <div>
        <span class="eyebrow">Conta conectada</span>
        <h1>RetroAchievements</h1>
        <p>${esc(ra.username)} · ${ra.online ? 'online' : 'verificação pendente'}</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="ra-refresh">${icon('refresh')} Atualizar perfil</button>
        <button class="btn btn-danger" data-action="ra-disconnect">Desconectar</button>
      </div>
    </div>
    <div class="ra-hero">
      <div class="ra-hero-main">
        <div class="ra-mark">${icon('trophy')}</div>
        <h2>${esc(profile.user ?? ra.username)}</h2>
        <p>${esc(profile.motto || 'Sua jornada de conquistas, registrada com integridade.')}</p>
        <div class="score-grid">
          <div class="score"><span>Pontos</span><strong>${profile.points ?? 0}</strong></div>
          <div class="score"><span>TruePoints</span><strong>${profile.truePoints ?? 0}</strong></div>
        </div>
        <div class="info-box">Abra um jogo na biblioteca para vincular o ID do RetroAchievements e sincronizar conquistas.</div>
      </div>
      <div class="ra-side">
        <h3>Perfil</h3>
        <div class="profile-mini">
          ${
            profile.avatar
              ? `<img src="${esc(profile.avatar)}" alt="">`
              : `<span class="fallback-avatar">${esc(String(ra.username).slice(0, 2).toUpperCase())}</span>`
          }
          <div><strong>${esc(ra.username)}</strong><span>${ra.online ? 'API online' : 'API não verificada'}</span></div>
        </div>
        <div class="hardcore-panel ${ra.hardcore ? 'is-active' : ''}">
          <div>
            <strong>Modo Hardcore</strong>
            <p>${ra.hardcore ? 'Ativo: Save States desabilitados imediatamente em todo o aplicativo.' : 'Quando ativado, cria e carrega estados ficam bloqueados. Exige conexão ativa.'}</p>
          </div>
          <button class="toggle-button ${ra.hardcore ? 'is-active' : ''}" data-action="ra-toggle-hardcore" aria-pressed="${ra.hardcore}"><span></span></button>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><div><h3>Integração de conquistas</h3><p>Tracker e patches são responsabilidade do bridge do núcleo</p></div></div>
      <div class="panel-body" style="color:var(--muted);font-size:10px;line-height:1.65">
        O orquestrador mantém a sessão, o vínculo do jogo e o bloqueio Hardcore. A leitura de memória e o envio de conquistas
        usam o contrato do núcleo (RetroAchievements/rcheevos). Sem bridge, a conta e o bloqueio de Save States continuam funcionais,
        mas o tracker em tempo real não é ativado.
      </div>
    </div>`;
}

function autoInstallerCard(entry) {
  const progress = state.installProgress[entry.coreId];
  const installing = state.installingCores.includes(entry.coreId);
  const status = entry.installed
    ? `Gerenciado${entry.version ? ` · ${entry.version}` : ''}`
    : entry.detectedInSystem
      ? 'Detectado no sistema'
      : 'Não instalado';
  const statusClass = entry.installed || entry.detectedInSystem ? 'ok' : 'warn';
  const buttonLabel = installing ? 'Instalando…' : entry.installed ? 'Atualizar' : 'Instalar';
  return `
    <div class="install-card" id="install-card-${esc(entry.coreId)}">
      <div class="install-card-head">
        <div class="install-icon">${icon('database')}</div>
        <div class="install-title">
          <strong>${esc(entry.label)}</strong>
          <span>${entry.platforms.map((platformId) => esc(platformOf(platformId).shortName)).join(' · ')}</span>
        </div>
        <span class="status-pill ${statusClass}">${esc(status)}</span>
      </div>
      <div class="install-progress ${installing || (progress && progress.phase !== 'done') ? '' : 'is-hidden'}" data-install-progress="${esc(entry.coreId)}">
        <div class="install-progress-head">
          <span data-install-phase="${esc(entry.coreId)}">${esc(INSTALL_PHASE_LABEL[progress?.phase] ?? progress?.phase ?? 'Preparando')}</span>
          <span data-install-percent="${esc(entry.coreId)}">${Number(progress?.percent ?? 0)}%</span>
        </div>
        <div class="progress-track">
          <span data-install-bar="${esc(entry.coreId)}" style="width:${Number(progress?.percent ?? 0)}%"></span>
        </div>
      </div>
      <div class="install-card-actions">
        <button class="btn btn-sm ${entry.installed || entry.detectedInSystem ? '' : 'btn-primary'}"
          data-action="install-core" data-core="${esc(entry.coreId)}" ${installing ? 'disabled' : ''}>
          ${icon('plus')} ${buttonLabel}
        </button>
        <button class="btn btn-sm btn-ghost" data-action="open-core-site" data-core="${esc(entry.coreId)}">
          ${icon('info')} Fonte oficial
        </button>
      </div>
    </div>`;
}

function renderSettings() {
  const settings = state.settings ?? {};
  const resolutionOptions = [
    ['windowed', 'Janela'],
    ['native', 'Nativa'],
    ['720p', '720p'],
    ['1080p', '1080p'],
    ['1440p', '1440p'],
    ['4k', '4K'],
  ];
  const filterOptions = [
    ['none', 'Sem filtro'],
    ['crt', 'CRT'],
    ['scanlines', 'Scanlines'],
    ['bilinear', 'Bilinear'],
    ['aa', 'Anti-aliasing'],
  ];
  const cores = state.cores.length ? state.cores : (state.info?.cores ?? []);
  return `
    <div class="page-head">
      <div>
        <span class="eyebrow">Preferências locais</span>
        <h1>Configurações</h1>
        <p>Vídeo, áudio, metadados e caminhos do sistema.</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="open-data">${icon('folder')} Abrir dados</button>
        <button class="btn" data-action="reveal-cores">${icon('settings')} Pasta dos núcleos</button>
      </div>
    </div>

    <div class="settings-layout">
      <div>
        <section class="settings-section">
          <h3>${icon('monitor')} Vídeo</h3>
          <p>Preferências repassadas ao núcleo no momento do launch.</p>
          <div class="setting-row">
            <div><strong>Resolução</strong><small>Nativa ou escalonada</small></div>
            <select data-setting="video.resolution">
              ${resolutionOptions.map(([value, label]) => `<option value="${value}" ${settings['video.resolution'] === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </div>
          <div class="setting-row">
            <div><strong>Filtro pós-processamento</strong><small>CRT, scanlines ou bilinear</small></div>
            <select data-setting="video.filter">
              ${filterOptions.map(([value, label]) => `<option value="${value}" ${settings['video.filter'] === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </div>
          <div class="setting-row">
            <div><strong>Proporção</strong><small>Aspect ratio de saída</small></div>
            <select data-setting="video.aspectRatio">
              ${['4:3', '16:9', 'stretch'].map((value) => `<option value="${value}" ${settings['video.aspectRatio'] === value ? 'selected' : ''}>${value === 'stretch' ? 'Esticar' : value}</option>`).join('')}
            </select>
          </div>
        </section>

        <section class="settings-section">
          <h3>${icon('controller')} Áudio e entrada</h3>
          <p>Volume global e dispositivo de saída.</p>
          <div class="setting-row">
            <div><strong>Volume global</strong><small>0 a 100</small></div>
            <input type="number" min="0" max="100" value="${Number(settings['audio.volume'] ?? 80)}" data-setting="audio.volume">
          </div>
          <div class="setting-row">
            <div><strong>Dispositivo de áudio</strong><small>Saída padrão do sistema</small></div>
            <select data-setting="audio.device">
              <option value="default" ${settings['audio.device'] === 'default' ? 'selected' : ''}>Padrão do sistema</option>
            </select>
          </div>
        </section>

        <section class="settings-section">
          <h3>${icon('search')} Metadados</h3>
          <p>APIs externas protegidas por janela deslizante de 50 requisições/minuto.</p>
          <div class="setting-row">
            <div><strong>Provedor preferido</strong><small>Fallback automático para o outro provedor</small></div>
            <select data-setting="metadata.provider">
              <option value="screenscraper" ${settings['metadata.provider'] === 'screenscraper' ? 'selected' : ''}>ScreenScraper</option>
              <option value="igdb" ${settings['metadata.provider'] === 'igdb' ? 'selected' : ''}>IGDB</option>
            </select>
          </div>
          <form class="form-grid" data-metadata-form="screenscraper">
            <div class="form-row">
              <div class="field"><label>ScreenScraper dev ID</label><input name="devId" placeholder="devid" autocomplete="off"></div>
              <div class="field"><label>ScreenScraper dev password</label><input name="devPassword" type="password" autocomplete="off"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>Usuário (opcional)</label><input name="user" autocomplete="off"></div>
              <div class="field"><label>Senha do usuário (opcional)</label><input name="password" type="password" autocomplete="off"></div>
            </div>
            <div class="form-actions">
              ${state.metadata?.screenscraperConfigured ? '<span class="status-pill ok">Configurado</span>' : ''}
              <button class="btn btn-sm" type="submit">Salvar ScreenScraper</button>
            </div>
          </form>
          <form class="form-grid mt-16" data-metadata-form="igdb">
            <div class="form-row">
              <div class="field"><label>IGDB Client ID</label><input name="clientId" autocomplete="off"></div>
              <div class="field"><label>IGDB Client Secret</label><input name="clientSecret" type="password" autocomplete="off"></div>
            </div>
            <div class="form-actions">
              ${state.metadata?.igdbConfigured ? '<span class="status-pill ok">Configurado</span>' : ''}
              <button class="btn btn-sm" type="submit">Salvar IGDB</button>
            </div>
          </form>
        </section>
      </div>

      <div>
        <section class="settings-section">
          <h3>${icon('database')} Instalação automática</h3>
          <p>Downloads oficiais dos emuladores pesados. BIOS, firmware e jogos continuam sendo fornecidos por você.</p>
          <div class="install-grid">
            ${state.installCatalog.map(autoInstallerCard).join('') || '<div class="empty-inline">Catálogo de instaladores indisponível.</div>'}
          </div>
          <div class="info-box mt-12">PCSX2, RPCS3, xemu e Xenia são baixados do GitHub oficial, extraídos no diretório gerenciado e verificados por SHA-256 quando a release publica checksum. A instalação não inclui BIOS, firmware, HDD do Xbox ou jogos.</div>
        </section>

        <section class="settings-section">
          <h3>${icon('monitor')} Núcleos detectados</h3>
          <p>Binários encontrados no sistema ou configurados em cores.json.</p>
          ${cores
            .map(
              (core) => `
            <div class="core-line ${core.installed ? 'installed' : ''}">
              <span class="core-dot"></span>
              <strong>${esc(core.label)}</strong>
              <span>${core.installed ? 'disponível' : 'não encontrado'}</span>
            </div>`,
            )
            .join('')}
          <div class="info-box mt-12">Save State gerenciável depende de um bridge compatível. Sem bridge, o núcleo externo abre normalmente, mas os controles de estado ficam indisponíveis.</div>
        </section>

        <section class="settings-section">
          <h3>${icon('folder')} Caminhos</h3>
          <p>Dados persistentes no perfil local.</p>
          <div class="path-box">${icon('folder')} ${esc(state.info?.savesRoot ?? '')}</div>
          <div class="path-box">${icon('database')} ${esc(state.info?.dataRoot ?? '')}</div>
          <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
            <button class="btn btn-sm" data-action="open-saves">Abrir saves</button>
            <button class="btn btn-sm" data-action="open-logs">Abrir logs</button>
          </div>
        </section>

        <section class="settings-section">
          <h3>${icon('info')} Sobre</h3>
          <div class="about-block">
            <div class="brand-mark"><span>W</span><span>3</span></div>
            <div><strong>W3Labs Entertainment System</strong><span>v${esc(state.info?.version ?? '0.1.0')} · Electron ${esc(api.versions.electron)}</span></div>
          </div>
          <p class="mt-12" style="color:var(--muted-2);font-size:9px;line-height:1.6">Banco SQLite em WAL, IPC assíncrono com contextIsolation e sandbox, hashes em streaming e isolamento de núcleos pesados.</p>
        </section>
      </div>
    </div>`;
}

/* ── Modais ─────────────────────────────────────── */

function openModal(html, className = '') {
  state.modal = { ...(state.modal ?? {}), className };
  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal ${className}" role="dialog" aria-modal="true">${html}</div>
    </div>`;
  const closeButton = $('#modalRoot [data-action="close-modal"]');
  if (closeButton) closeButton.focus();
}

function closeModal({ resolve = false } = {}) {
  if (state.confirmResolve) {
    if (resolve) state.confirmResolve(true);
    state.confirmResolve = null;
  }
  $('#modalRoot').innerHTML = '';
  state.modal = null;
  state.pendingLaunch = null;
}

async function openGame(gameId) {
  try {
    const [game, saves] = await Promise.all([api.library.get(gameId), api.saves.list(gameId)]);
    state.modal = { type: 'game', game, saves };
    renderGameModal();
  } catch (error) {
    handleError(error, 'Falha ao abrir jogo');
  }
}

function renderGameModal() {
  if (state.modal?.type !== 'game') return;
  const { game, saves } = state.modal;
  const platform = platformOf(game.platformId);
  const active = state.active?.gameId === game.id ? state.active : null;
  const hardcore = Boolean(state.ra?.hardcore);
  const bootGuard = active?.bootGuard?.active ? active.bootGuard : null;
  const canStates =
    Boolean(active) &&
    active.capabilities?.saveState &&
    active.capabilities?.loadState &&
    !hardcore &&
    !bootGuard;
  const savesBySlot = new Map(saves.map((entry) => [entry.slot, entry]));
  const slots = Array.from({ length: 8 }, (_, slot) => {
    const entry = savesBySlot.get(slot);
    return `
      <div class="save-slot ${entry ? 'has-state' : ''}">
        <div class="slot-head"><strong>Slot ${slot}</strong><span>${entry ? formatBytes(entry.sizeBytes) : 'vazio'}</span></div>
        <div class="slot-meta">${entry ? `${formatDate(entry.updatedAt)}<br>${esc(entry.coreId)}` : 'Sem estado'}</div>
        <div class="slot-actions">
          <button class="btn btn-sm" data-action="save-state" data-slot="${slot}" ${canStates ? '' : 'disabled'}>Salvar</button>
          <button class="btn btn-sm" data-action="load-state" data-slot="${slot}" ${canStates && entry ? '' : 'disabled'}>Carregar</button>
          ${entry ? `<button class="ghost-icon" data-action="delete-state" data-slot="${slot}" title="Excluir">${icon('trash')}</button>` : ''}
        </div>
      </div>`;
  }).join('');

  openModal(
    `
    <div class="modal-head">
      <div>
        <h2>${esc(game.title)}</h2>
        <p>${esc(platform.name)} · ${esc(game.fileName)}</p>
      </div>
      <button class="icon-button" data-action="close-modal" aria-label="Fechar">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <div class="game-detail">
        <div class="detail-cover" style="--platform-color:${esc(platform.color)}">
          ${game.coverUrl ? `<img src="${esc(game.coverUrl)}" alt="">` : ''}
          <span class="cover-monogram">${esc(initials(game.title))}</span>
        </div>
        <div class="detail-info">
          <span class="platform-badge" style="position:static;display:inline-block;margin-bottom:6px">${esc(platform.shortName)}</span>
          <h2>${esc(game.title)}</h2>
          <div class="detail-sub">
            <span>${esc(game.regionLabel)}</span><i></i><span>${game.releaseYear || 'Ano ?'}</span><i></i>
            <span>${game.publisher ? esc(game.publisher) : 'Publicadora ?'}</span><i></i><span>${formatPlaytime(game.playtimeSeconds)}</span>
          </div>
          <div class="detail-tags">
            ${game.genre ? `<span class="tag">${esc(game.genre)}</span>` : ''}
            ${game.serial ? `<span class="tag">${esc(game.serial)}</span>` : ''}
            ${game.discNumber > 1 ? `<span class="tag">Disco ${game.discNumber}</span>` : ''}
            <span class="tag">SHA-1 ${esc(String(game.romHash).slice(0, 8))}</span>
          </div>
          <p class="detail-synopsis">${game.synopsis ? esc(game.synopsis) : 'Sem sinopse. Use “Buscar metadados” para consultar as APIs configuradas.'}</p>
          <div class="detail-actions">
            ${
              active
                ? `<button class="btn btn-primary" disabled>${icon('play')} Em execução</button>
                   <button class="btn" data-action="toggle-pause">${icon(active.paused ? 'play' : 'pause')} ${active.paused ? 'Retomar' : 'Pausar'}</button>
                   <button class="btn btn-danger" data-action="stop-session">${icon('stop')} Encerrar</button>`
                : `<button class="btn btn-primary" data-action="launch">${icon('play')} Iniciar jogo</button>`
            }
            <button class="btn" data-action="toggle-favorite">${icon('star')} ${game.favorite ? 'Favorito' : 'Favoritar'}</button>
            <button class="btn" data-action="scrape">${icon('refresh')} Metadados</button>
          </div>
          <div class="detail-meta-row">
            <div><span>Plataforma</span>
              <select id="gamePlatform" class="detail-select" data-game="${esc(game.id)}" ${active ? 'disabled' : ''}>
                ${state.platforms.map((entry) => `<option value="${esc(entry.id)}" ${game.platformId === entry.id ? 'selected' : ''}>${esc(entry.shortName)}</option>`).join('')}
              </select>
            </div>
            <div><span>Região</span>
              <select id="gameRegion" class="detail-select" data-game="${esc(game.id)}" data-region="${esc(game.id)}">
                ${game.region === 'unknown' ? '<option value="" selected disabled>Definir região</option>' : ''}
                ${['ntsc-u', 'ntsc-j', 'pal', 'global'].map((region) => `<option value="${region}" ${game.region === region ? 'selected' : ''}>${region.toUpperCase()}</option>`).join('')}
              </select>
            </div>
            <div><span>Arquivo</span><strong>${formatBytes(game.fileSize)}</strong></div>
            <div><span>Núcleo</span><strong>${esc(active?.coreLabel ?? platform.defaultCore)}</strong></div>
            <div><span>Isolamento</span><strong>${platform.isolated ? 'Processo filho' : '—'}</strong></div>
          </div>
        </div>
      </div>

      <div class="save-section">
        <h3>${icon('save')} Save States</h3>
        <p>Armazenamento obrigatório em <span class="mono">saves/${esc(platform.id)}/${esc(String(game.romHash).slice(0, 10))}…/[slot].state</span></p>
        ${hardcore ? `<div class="hardcore-banner">${icon('hardcore')} Modo Hardcore ativo: criação e carregamento de estados estão bloqueados.</div>` : ''}
        ${bootGuard ? `<div class="hardcore-banner" style="border-color:rgba(244,184,96,.22);background:rgba(244,184,96,.05);color:#dfc08f">${icon('clock')} <span id="bootGuardText">Boot da BIOS em andamento · ${bootGuard.remainingSeconds}s restantes</span></div>` : ''}
        ${!hardcore && !bootGuard && active && !active.capabilities?.saveState ? `<div class="hardcore-banner" style="border-color:var(--line);background:rgba(255,255,255,.02);color:var(--muted)">${icon('info')} O núcleo atual não expõe bridge de Save State.</div>` : ''}
        ${!active && !hardcore ? `<div class="hardcore-banner" style="border-color:var(--line);background:rgba(255,255,255,.02);color:var(--muted)">${icon('info')} Inicie o jogo para habilitar os estados.</div>` : ''}
        <div class="save-slots">${slots}</div>
      </div>

      ${
        state.ra?.connected
          ? `<div class="save-section">
              <h3>${icon('trophy')} RetroAchievements</h3>
              <p>Vincule este jogo ao ID da RA para sincronizar conquistas. O vínculo não altera o arquivo.</p>
              <div class="inline-form">
                <div class="field"><label for="raGameId">ID do jogo no RetroAchievements</label><input id="raGameId" type="number" min="1" placeholder="ex.: 1121"></div>
                <button class="btn" data-action="link-ra">Vincular</button>
                <button class="btn" data-action="sync-ra">Sincronizar</button>
              </div>
            </div>`
          : ''
      }
    </div>
    <div class="modal-footer">
      <button class="btn btn-danger" data-action="remove-game">${icon('trash')} Remover da biblioteca</button>
      <span class="spacer"></span>
      <button class="btn" data-action="close-modal">Fechar</button>
    </div>
    `,
    'modal-wide',
  );
}

function showHardwareWarning(error) {
  const details = error.details ?? {};
  const gameId = state.pendingLaunch?.gameId ?? state.modal?.game?.id;
  state.pendingLaunch = { gameId };
  openModal(
    `
    <div class="modal-head">
      <div><h2>Aviso de hardware</h2><p>${esc(state.modal?.game?.title ?? 'Plataforma pesada')}</p></div>
      <button class="icon-button" data-action="close-modal" aria-label="Fechar">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <p style="margin-top:0;color:var(--muted);font-size:10.5px;line-height:1.6">O sistema identificou possíveis limitações. Você pode continuar por sua conta e risco, como previsto na regra de negócio.</p>
      <ul class="warning-list">${(details.warnings ?? [error.message]).map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>
      <div class="info-box">GPU dedicada: ${details.hardwareInfo?.dedicatedGpu ? 'detectada' : 'não detectada'} · RAM: ${details.hardwareInfo?.totalRamGb ?? '?'} GB</div>
    </div>
    <div class="modal-footer">
      <button class="btn" data-action="close-modal">Cancelar</button>
      <button class="btn btn-primary" data-action="launch-ack">Continuar mesmo assim</button>
    </div>
  `,
    'modal-sm',
  );
}

function askConfirm({ title, message, confirmLabel = 'Confirmar', danger = false, action = 'confirm-yes' }) {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    openModal(
      `
      <div class="modal-head">
        <div><h2>${esc(title)}</h2></div>
        <button class="icon-button" data-action="close-modal" aria-label="Fechar">${icon('close')}</button>
      </div>
      <div class="modal-body"><p style="margin:0;color:var(--muted);font-size:10.5px;line-height:1.65">${esc(message)}</p></div>
      <div class="modal-footer">
        <button class="btn" data-action="confirm-no">Cancelar</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="${action}">${esc(confirmLabel)}</button>
      </div>
    `,
      'modal-sm',
    );
  });
}

const BIOS_REGION_LABELS = {
  'ntsc-u': 'NTSC-U (USA)',
  'ntsc-j': 'NTSC-J (Japão)',
  pal: 'PAL (Europa)',
  global: 'Global / region-free',
};

function customBiosPlatforms() {
  return state.platforms.filter((platform) => (platform.biosKinds?.length ?? 0) > 0);
}

function customBiosSelectorData(platformId) {
  const platform = platformOf(platformId);
  const regions = [...(platform.biosRegions ?? [])];
  if (!regions.includes('global')) regions.push('global');
  const kinds = platform.biosKinds?.length ? platform.biosKinds : ['bios'];
  return { platform, regions, kinds };
}

function refreshCustomBiosSelectors({ keepSelection = false } = {}) {
  const platformSelect = $('#customBiosPlatform');
  const regionSelect = $('#customBiosRegion');
  const kindSelect = $('#customBiosKind');
  if (!platformSelect || !regionSelect || !kindSelect) return;
  const previousRegion = keepSelection ? regionSelect.value : null;
  const previousKind = keepSelection ? kindSelect.value : null;
  const { regions, kinds } = customBiosSelectorData(platformSelect.value);
  regionSelect.innerHTML = regions
    .map((region) => `<option value="${esc(region)}">${esc(BIOS_REGION_LABELS[region] ?? region)}</option>`)
    .join('');
  kindSelect.innerHTML = kinds
    .map((kind) => `<option value="${esc(kind)}">${esc(kind.toUpperCase())}</option>`)
    .join('');
  if (previousRegion && regions.includes(previousRegion)) regionSelect.value = previousRegion;
  if (previousKind && kinds.includes(previousKind)) kindSelect.value = previousKind;
}

function openCustomBiosModal(platformHint = null, hashes = null) {
  const platforms = customBiosPlatforms();
  if (platforms.length === 0) {
    toast('Nenhuma plataforma com BIOS configurada.', { type: 'warn' });
    return;
  }
  const initialPlatform = platforms.some((platform) => platform.id === platformHint)
    ? platformHint
    : platforms[0].id;
  const { regions, kinds } = customBiosSelectorData(initialPlatform);
  openModal(
    `
    <div class="modal-head">
      <div><h2>BIOS personalizada</h2><p>Para dumps legítimos fora do catálogo</p></div>
      <button class="icon-button" data-action="close-modal" aria-label="Fechar">${icon('close')}</button>
    </div>
    <form id="customBiosForm">
      <div class="modal-body">
        <div class="legal-note" style="margin-bottom:16px">
          ${icon('hardcore')}
          <div>
            <strong>Atestação obrigatória</strong>
            <p>Use somente um dump extraído do seu próprio console ou de fonte licenciada. O sistema não identifica automaticamente a versão: você informa plataforma, região e tipo, e o W3Labs grava os hashes MD5/SHA-1 para revalidar a integridade em cada boot.</p>
          </div>
        </div>
        ${hashes ? `<div class="info-box" style="margin-bottom:14px">Arquivo lido anteriormente:<br><span class="hash">MD5 ${esc(hashes.md5)}</span><br><span class="hash">SHA-1 ${esc(hashes.sha1)}</span><br>Selecione o mesmo arquivo para concluir a importação personalizada.</div>` : ''}
        <div class="form-grid">
          <div class="form-row">
            <div class="field">
              <label for="customBiosPlatform">Plataforma</label>
              <select id="customBiosPlatform" name="platformId">
                ${platforms.map((platform) => `<option value="${esc(platform.id)}" ${platform.id === initialPlatform ? 'selected' : ''}>${esc(platform.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label for="customBiosKind">Tipo</label>
              <select id="customBiosKind" name="kind">
                ${kinds.map((kind) => `<option value="${esc(kind)}">${esc(kind.toUpperCase())}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="field">
              <label for="customBiosRegion">Região da BIOS</label>
              <select id="customBiosRegion" name="region">
                ${regions.map((region) => `<option value="${esc(region)}">${esc(BIOS_REGION_LABELS[region] ?? region)}</option>`).join('')}
              </select>
              <small>Precisa corresponder à região do jogo; BIOS global também é aceita.</small>
            </div>
            <div class="field">
              <label for="customBiosLabel">Rótulo</label>
              <input id="customBiosLabel" name="label" maxlength="120" placeholder="Ex.: Meu dump SCPH-70012">
            </div>
          </div>
          <div class="info-box">
            Tamanhos aceitos: PS1 512 KB · PS2 4 MB · Xbox MCPX 512 B, flash 256 KB/1 MB · Game Boy 256 B/2.304 B.
            Para Xbox, importe o boot ROM MCPX e a BIOS flash separadamente.
          </div>
          <label class="field" style="flex-direction:row;align-items:flex-start;gap:8px;color:var(--muted);font-size:10px;line-height:1.5">
            <input id="customBiosAck" name="acknowledged" type="checkbox" required style="width:auto;min-height:auto;margin-top:2px">
            <span>Confirmo que este arquivo é um dump do meu próprio hardware ou de fonte licenciada, e assumo a responsabilidade pela região/tipo informados.</span>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn btn-primary" type="submit">${icon('folder')} Selecionar arquivo e importar</button>
      </div>
    </form>
  `,
    'modal-sm',
  );
}

function openCoreInstallModal(coreId, detail = null) {
  const entry = state.installCatalog.find((item) => item.coreId === coreId);
  if (!entry) {
    toast('Instalador automático indisponível para este núcleo.', { type: 'warn' });
    return;
  }
  state.modal = { type: 'install-core', coreId };
  openModal(
    `
    <div class="modal-head">
      <div><h2>Instalar ${esc(entry.label)}</h2><p>Download oficial e instalação gerenciada</p></div>
      <button class="icon-button" data-action="close-modal" aria-label="Fechar">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <p style="margin-top:0;color:var(--muted);font-size:10.5px;line-height:1.6">
        ${detail ? esc(detail) : 'O emulador ainda não está disponível. O W3Labs pode baixar a release oficial, extrair e configurar o caminho automaticamente.'}
      </p>
      <div class="install-modal-meta">
        <div><span>Plataformas</span><strong>${entry.platforms.map((id) => esc(platformOf(id).shortName)).join(' · ')}</strong></div>
        <div><span>Fonte</span><strong>${esc(entry.repo)}</strong></div>
      </div>
      <div class="install-progress" data-install-progress="${esc(coreId)}">
        <div class="install-progress-head">
          <span data-install-phase="${esc(coreId)}">${esc(INSTALL_PHASE_LABEL[state.installProgress[coreId]?.phase] ?? state.installProgress[coreId]?.phase ?? 'Aguardando')}</span>
          <span data-install-percent="${esc(coreId)}">${Number(state.installProgress[coreId]?.percent ?? 0)}%</span>
        </div>
        <div class="progress-track"><span data-install-bar="${esc(coreId)}" style="width:${Number(state.installProgress[coreId]?.percent ?? 0)}%"></span></div>
      </div>
      <div class="info-box mt-12">BIOS, firmware, HDD do Xbox e jogos não são baixados. O pacote vem do repositório oficial do projeto.</div>
    </div>
    <div class="modal-footer">
      <button class="btn" data-action="open-core-site" data-core="${esc(coreId)}">Abrir site oficial</button>
      <button class="btn btn-primary" data-action="install-core" data-core="${esc(coreId)}" ${state.installingCores.includes(coreId) ? 'disabled' : ''}>Instalar agora</button>
    </div>
  `,
    'modal-sm',
  );
}

const INSTALL_PHASE_LABEL = {
  release: 'Consultando release oficial',
  download: 'Baixando',
  verify: 'Verificando SHA-256',
  extract: 'Extraindo pacote',
  done: 'Concluído',
};

function updateInstallProgressUI(progress) {
  const { coreId } = progress;
  state.installProgress[coreId] = progress;
  const containers = document.querySelectorAll(`[data-install-progress="${coreId}"]`);
  containers.forEach((container) => {
    container.classList.remove('is-hidden');
    const phase = container.querySelector(`[data-install-phase="${coreId}"]`);
    const percent = container.querySelector(`[data-install-percent="${coreId}"]`);
    const bar = container.querySelector(`[data-install-bar="${coreId}"]`);
    if (phase) phase.textContent = INSTALL_PHASE_LABEL[progress.phase] ?? progress.phase;
    if (percent) percent.textContent = `${Number(progress.percent) || 0}%`;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(progress.percent) || 0))}%`;
  });
  document.querySelectorAll(`[data-action="install-core"][data-core="${coreId}"]`).forEach((button) => {
    if (state.installingCores.includes(coreId)) {
      button.disabled = true;
      button.textContent = 'Instalando…';
    }
  });
}

async function installCore(coreId) {
  if (state.installingCores.includes(coreId)) return;
  state.installingCores.push(coreId);
  state.installProgress[coreId] = { coreId, phase: 'release', percent: 0 };
  updateInstallProgressUI(state.installProgress[coreId]);
  try {
    const result = await api.cores.install(coreId);
    state.installCatalog = result.catalog ?? state.installCatalog;
    state.cores = await api.cores.status();
    state.installProgress[coreId] = { coreId, phase: 'done', percent: 100 };
    updateInstallProgressUI(state.installProgress[coreId]);
    if (state.modal?.type === 'install-core') closeModal();
    if (state.view === 'settings') renderView();
    toast(
      result.upToDate
        ? `${result.label} já está atualizado (${result.version}).`
        : `${result.label} ${result.version} instalado automaticamente.`,
      { title: 'Núcleo pronto' },
    );
  } catch (error) {
    handleError(error, 'Falha na instalação automática');
    if (state.view === 'settings') renderView();
  } finally {
    state.installingCores = state.installingCores.filter((id) => id !== coreId);
    if (state.view === 'settings') renderView();
  }
}

function openKeyboardProfileModal() {
  openModal(
    `
    <div class="modal-head">
      <div><h2>Novo perfil de teclado</h2><p>Não exige GUID de hardware</p></div>
      <button class="icon-button" data-action="close-modal" aria-label="Fechar">${icon('close')}</button>
    </div>
    <form id="keyboardProfileForm">
      <div class="modal-body">
        <div class="form-grid">
          <div class="form-row">
            <div class="field">
              <label for="keyboardPlayer">Jogador</label>
              <select id="keyboardPlayer" name="playerIndex">
                ${[1, 2, 3, 4].map((player) => `<option value="${player}">Player ${player}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label for="keyboardName">Nome do perfil</label>
              <input id="keyboardName" name="name" placeholder="Teclado — Player 1" maxlength="80" required>
            </div>
          </div>
          <div class="info-box">O mapeamento padrão WASD + IJKL pode ser editado depois. Perfis de teclado não representam hardware físico e não passam pela validação de GUID.</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn btn-primary" type="submit">Criar perfil</button>
      </div>
    </form>
  `,
    'modal-sm',
  );
}

function openMappingModal(profileId) {
  const profile = state.profiles.find((entry) => entry.id === profileId);
  if (!profile) return;
  const labels = {
    up: 'Cima',
    down: 'Baixo',
    left: 'Esquerda',
    right: 'Direita',
    south: 'Sul / A',
    east: 'Leste / B',
    west: 'Oeste / X',
    north: 'Norte / Y',
    start: 'Start',
    select: 'Select',
    l1: 'L1',
    r1: 'R1',
    l2: 'L2',
    r2: 'R2',
    leftStick: 'L3',
    rightStick: 'R3',
  };
  openModal(`
    <div class="modal-head">
      <div><h2>Mapeamento · ${esc(profile.name)}</h2><p>${esc(profile.api.toUpperCase())} · Player ${profile.playerIndex}</p></div>
      <button class="icon-button" data-action="close-modal" aria-label="Fechar">${icon('close')}</button>
    </div>
    <form id="mappingForm" data-profile="${esc(profile.id)}">
      <div class="modal-body">
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          ${Object.entries(profile.mapping)
            .map(
              ([key, value]) => `
            <div class="field">
              <label for="map-${esc(key)}">${esc(labels[key] ?? key)}</label>
              <input id="map-${esc(key)}" name="${esc(key)}" value="${esc(value)}" maxlength="80">
            </div>`,
            )
            .join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn btn-primary" type="submit">Salvar mapeamento</button>
      </div>
    </form>
  `);
}

/* ── Ações ──────────────────────────────────────── */

async function addRoot() {
  const root = await api.library.pickRoot();
  if (!root) return;
  await api.library.addRoot(root, null);
  state.roots = await api.library.roots();
  toast('Pasta adicionada. Iniciando escaneamento...', { title: 'Biblioteca' });
  await scanLibrary();
}

async function scanLibrary() {
  if (state.scan?.active) return;
  if (state.roots.length === 0) {
    toast('Adicione uma pasta antes de escanear.', { title: 'Nenhuma pasta', type: 'warn' });
    return;
  }
  state.scan = { active: true, filesSeen: 0, added: 0 };
  const dock = $('#scanDock');
  dock.hidden = false;
  $('#scanTitle').textContent = 'Escaneando biblioteca';
  $('#scanDetail').textContent = 'Percorrendo diretórios...';
  $('#scanPercent').textContent = '';
  $('#scanProgress').style.width = '3%';
  try {
    const summary = await api.library.scan();
    $('#scanProgress').style.width = '100%';
    $('#scanPercent').textContent = '100%';
    $('#scanTitle').textContent = 'Escaneamento concluído';
    $('#scanDetail').textContent =
      `${summary.filesSeen} arquivos vistos · ${summary.gamesAdded} novos · ${summary.gamesUpdated} atualizados`;
    await refreshLibraryData();
    toast(
      `${summary.gamesAdded} jogo(s) adicionado(s), ${summary.gamesUpdated} atualizado(s)${summary.errors.length ? `, ${summary.errors.length} erro(s)` : ''}.`,
      { title: 'Acervo atualizado', type: summary.errors.length ? 'warn' : 'info' },
    );
  } catch (error) {
    handleError(error, 'Falha no escaneamento');
    $('#scanTitle').textContent = 'Escaneamento interrompido';
    $('#scanDetail').textContent = error.message;
  } finally {
    state.scan.active = false;
    window.setTimeout(() => {
      if (!state.scan?.active) dock.hidden = true;
    }, 3800);
  }
}

async function refreshLibraryData() {
  const [stats, games, roots] = await Promise.all([
    api.app.stats(),
    api.library.list({
      search: state.filters.search,
      platformId: state.filters.platform,
      limit: 300,
    }),
    api.library.roots(),
  ]);
  state.stats = stats;
  state.games = games;
  state.roots = roots;
  renderView();
}

async function launchGame(gameId, acknowledgedWarnings = false) {
  try {
    state.pendingLaunch = { gameId };
    await api.emulation.launch(gameId, { acknowledgedWarnings });
    state.active = await api.emulation.active();
    state.pendingLaunch = null;
    closeModal({ resolve: false });
    syncShell();
    toast('Sessão de emulação iniciada em processo isolado.', { title: 'Jogo iniciado' });
  } catch (error) {
    handleError(error, 'Falha ao iniciar jogo');
  }
}

async function toggleHardcore(next) {
  if (!state.ra?.connected) {
    toast('Conecte a conta do RetroAchievements para usar o modo Hardcore.', {
      title: 'Conta não conectada',
      type: 'warn',
    });
    switchView('achievements');
    return;
  }
  if (next && !state.ra?.hardcore && state.active) {
    const confirmed = await askConfirm({
      title: 'Ativar Hardcore em sessão ativa?',
      message:
        'Os Save States serão imediatamente desabilitados. A sessão atual continuará rodando, mas não poderá salvar ou carregar estados.',
      confirmLabel: 'Ativar Hardcore',
    });
    if (!confirmed) return;
    closeModal({ resolve: false });
  }
  try {
    state.ra = await api.retroachievements.setHardcore(next);
    syncShell();
    if (state.view === 'achievements') renderView();
    if (state.modal?.type === 'game') renderGameModal();
    toast(next ? 'Hardcore ativo. Save States bloqueados.' : 'Hardcore desativado.', {
      title: 'RetroAchievements',
      type: next ? 'warn' : 'info',
    });
  } catch (error) {
    handleError(error, 'Falha ao alterar Hardcore');
  }
}

async function detectControllers() {
  try {
    const pads = navigator.getGamepads
      ? [...navigator.getGamepads()].filter(Boolean).map((pad) => ({
          index: pad.index,
          id: pad.id,
          mapping: pad.mapping,
          connected: pad.connected,
          buttons: pad.buttons?.length ?? 0,
          axes: pad.axes?.length ?? 0,
          hardwareGuid:
            String(pad.id).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ??
            null,
        }))
      : [];
    state.detected = await api.controllers.inspect(pads, state.active?.platformId ?? null);
    renderView();
    if (state.detected.devices.length === 0) {
      toast('Nenhum controle detectado. Conecte um dispositivo e tente novamente.', { type: 'warn' });
    }
  } catch (error) {
    handleError(error, 'Falha ao detectar controles');
  }
}

async function switchView(view) {
  if (!VIEW_META[view]) return;
  state.view = view;
  renderView();
  viewRoot.scrollTop = 0;
  try {
    if (view === 'bios') {
      [state.bios, state.matrix] = await Promise.all([api.bios.list(), api.bios.matrix()]);
      renderView();
    } else if (view === 'achievements') {
      state.ra = await api.retroachievements.status();
      renderView();
    } else if (view === 'settings') {
      [state.metadata, state.cores, state.installCatalog] = await Promise.all([
        api.metadata.status(),
        api.cores.status(),
        api.cores.installCatalog(),
      ]);
      renderView();
    } else if (view === 'library') {
      await refreshLibraryData();
    }
  } catch (error) {
    handleError(error);
  }
}

async function refreshCurrentView() {
  const btn = $('#refreshButton');
  btn?.classList.add('is-spinning');
  try {
    if (state.view === 'library') await refreshLibraryData();
    if (state.view === 'bios') {
      [state.bios, state.matrix] = await Promise.all([api.bios.list(), api.bios.matrix()]);
      renderView();
    }
    if (state.view === 'controllers') {
      state.profiles = await api.controllers.profiles();
      renderView();
    }
    if (state.view === 'achievements') {
      state.ra = await api.retroachievements.status();
      renderView();
    }
    if (state.view === 'settings') {
      [state.metadata, state.cores, state.installCatalog] = await Promise.all([
        api.metadata.status(),
        api.cores.status(),
        api.cores.installCatalog(),
      ]);
      renderView();
    }
  } catch (error) {
    handleError(error, 'Falha ao atualizar');
  } finally {
    window.setTimeout(() => btn?.classList.remove('is-spinning'), 600);
  }
}

function startLiveClock() {
  window.setInterval(() => {
    const guard = $('#bootGuardText');
    if (!guard || !state.active?.bootGuard?.active) return;
    const remaining = Math.max(
      0,
      Math.ceil(
        (new Date(state.active.startedAt).getTime() +
          (state.active.bootGuard.totalSeconds ?? 0) * 1000 -
          Date.now()) /
          1000,
      ),
    );
    if (remaining > 0) {
      guard.textContent = `Boot da BIOS em andamento · ${remaining}s restantes`;
    } else if (state.modal?.type === 'game') {
      api.saves.list(state.modal.game.id).then((saves) => {
        state.modal.saves = saves;
        state.active.bootGuard.active = false;
        renderGameModal();
      });
    }
  }, 1000);
}

/* ── Event delegation ───────────────────────────── */

document.addEventListener('click', async (event) => {
  const backdrop = event.target.closest('[data-backdrop]');
  if (backdrop && event.target === backdrop) {
    closeModal();
    return;
  }
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    await switchView(nav.dataset.nav);
    return;
  }
  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) return;
  const action = actionElement.dataset.action;
  if (actionElement.disabled) return;

  try {
    switch (action) {
      case 'reload':
        window.location.reload();
        return;
      case 'add-root':
        await addRoot();
        return;
      case 'scan':
        await scanLibrary();
        return;
      case 'open-game':
        await openGame(actionElement.dataset.game);
        return;
      case 'open-active-game':
        if (state.active) await openGame(state.active.gameId);
        return;
      case 'filter-platform': {
        state.filters.platform = actionElement.dataset.platform || null;
        const games = await api.library.list({
          search: state.filters.search,
          platformId: state.filters.platform,
          limit: 300,
        });
        state.games = games;
        renderView();
        return;
      }
      case 'open-bios':
        await switchView('bios');
        return;
      case 'open-settings':
        await switchView('settings');
        return;
      case 'open-achievements':
        await switchView('achievements');
        return;
      case 'import-custom-bios':
        openCustomBiosModal(actionElement.dataset.platform || null);
        return;
      case 'import-bios': {
        try {
          const imported = await api.bios.chooseAndImport(actionElement.dataset.platform || null);
          if (imported) {
            toast(`BIOS “${imported.label}” validada por hash.`, { title: 'BIOS importada' });
            [state.bios, state.matrix] = await Promise.all([api.bios.list(), api.bios.matrix()]);
            syncShell();
            renderView();
          }
        } catch (error) {
          if (error.code === 'BIOS_HASH_NOT_RECOGNIZED') {
            toast(
              'Hash não catalogado. Preencha os dados do seu dump para importar como BIOS personalizada.',
              { title: 'BIOS fora do catálogo', type: 'warn', timeout: 6500 },
            );
            openCustomBiosModal(actionElement.dataset.platform || null, error.details);
            return;
          }
          throw error;
        }
        return;
      }
      case 'delete-bios': {
        const confirmed = await askConfirm({
          title: 'Remover BIOS?',
          message:
            'A cópia gerenciada será removida do armazenamento do aplicativo. Jogos que dependem dela deixarão de iniciar.',
          confirmLabel: 'Remover',
          danger: true,
        });
        if (!confirmed) return;
        const id = actionElement.dataset.id;
        // O modal de confirmação usa o mesmo root; o id fica no elemento capturado.
        closeModal({ resolve: false });
        await api.bios.remove(id);
        [state.bios, state.matrix] = await Promise.all([api.bios.list(), api.bios.matrix()]);
        syncShell();
        renderView();
        toast('BIOS removida.', { type: 'warn' });
        return;
      }
      case 'create-keyboard':
        openKeyboardProfileModal();
        return;
      case 'detect-controllers':
        await detectControllers();
        return;
      case 'bind-controller': {
        const index = Number(actionElement.dataset.index);
        const device = state.detected?.devices.find((entry) => entry.index === index);
        if (!device?.hardwareGuid) {
          toast('GUID de hardware não reportado pelo SO; vínculo recusado.', { type: 'warn' });
          return;
        }
        const used = new Set(state.profiles.map((profile) => profile.playerIndex));
        const player = [1, 2, 3, 4].find((entry) => !used.has(entry));
        if (!player) {
          toast('Todos os quatro perfis já estão em uso.', { type: 'warn' });
          return;
        }
        await api.controllers.saveProfile({
          playerIndex: player,
          name: device.id,
          api: device.mapping === 'standard' ? 'xinput' : 'directinput',
          hardwareGuid: device.hardwareGuid,
          productName: device.id,
        });
        state.profiles = await api.controllers.profiles();
        renderView();
        toast(`Controle vinculado ao Player ${player}.`, { title: 'Controle' });
        return;
      }
      case 'edit-mapping':
        openMappingModal(actionElement.dataset.id);
        return;
      case 'delete-profile': {
        const confirmed = await askConfirm({
          title: 'Remover perfil?',
          message: 'O mapeamento salvo será excluído. O controle físico não é alterado.',
          confirmLabel: 'Remover',
          danger: true,
        });
        if (!confirmed) return;
        const id = actionElement.dataset.id;
        closeModal({ resolve: false });
        await api.controllers.removeProfile(id);
        state.profiles = await api.controllers.profiles();
        renderView();
        return;
      }
      case 'ra-toggle-hardcore':
        await toggleHardcore(!state.ra?.hardcore);
        return;
      case 'ra-refresh':
        state.ra = await api.retroachievements.refresh();
        renderView();
        toast('Perfil do RetroAchievements atualizado.', { title: 'Conectado' });
        return;
      case 'ra-disconnect': {
        const confirmed = await askConfirm({
          title: 'Desconectar conta?',
          message: 'O Hardcore será desativado e a Web API Key cifrada será removida deste dispositivo.',
          confirmLabel: 'Desconectar',
          danger: true,
        });
        if (!confirmed) return;
        closeModal({ resolve: false });
        state.ra = await api.retroachievements.disconnect();
        syncShell();
        renderView();
        return;
      }
      case 'launch':
        if (state.modal?.game) await launchGame(state.modal.game.id, false);
        return;
      case 'launch-ack':
        if (state.pendingLaunch?.gameId) {
          const gameId = state.pendingLaunch.gameId;
          await launchGame(gameId, true);
        }
        return;
      case 'toggle-pause':
        if (state.active?.paused) {
          state.active = await api.emulation.resume();
        } else {
          state.active = await api.emulation.pause();
        }
        syncShell();
        if (state.modal?.type === 'game') renderGameModal();
        return;
      case 'stop-session': {
        const confirmed = await askConfirm({
          title: 'Encerrar sessão?',
          message: 'O tempo de jogo será contabilizado e o processo do núcleo será finalizado.',
          confirmLabel: 'Encerrar',
          danger: true,
          action: 'confirm-stop',
        });
        if (!confirmed) return;
        closeModal({ resolve: false });
        await api.emulation.stop();
        state.active = null;
        syncShell();
        toast('Sessão encerrada.', { title: 'Emulação' });
        return;
      }
      case 'save-state': {
        const slot = Number(actionElement.dataset.slot);
        actionElement.disabled = true;
        await api.saves.save(state.modal.game.id, slot);
        state.modal.saves = await api.saves.list(state.modal.game.id);
        renderGameModal();
        toast(`Estado salvo no slot ${slot}.`, { title: 'Save State' });
        return;
      }
      case 'load-state': {
        const slot = Number(actionElement.dataset.slot);
        const gameId = state.modal.game.id;
        const confirmed = await askConfirm({
          title: `Carregar slot ${slot}?`,
          message: 'O estado atual do jogo será substituído. Salve o progresso no jogo antes de continuar.',
          confirmLabel: 'Carregar estado',
        });
        if (!confirmed) return;
        closeModal({ resolve: false });
        await api.saves.load(gameId, slot);
        await openGame(gameId);
        toast(`Estado do slot ${slot} carregado.`, { title: 'Save State' });
        return;
      }
      case 'delete-state': {
        const slot = Number(actionElement.dataset.slot);
        const gameId = state.modal.game.id;
        const confirmed = await askConfirm({
          title: `Excluir slot ${slot}?`,
          message: 'O arquivo .state será removido do disco. Esta ação não pode ser desfeita.',
          confirmLabel: 'Excluir',
          danger: true,
        });
        if (!confirmed) return;
        closeModal({ resolve: false });
        await api.saves.remove(gameId, slot);
        state.modal.saves = await api.saves.list(gameId);
        renderGameModal();
        return;
      }
      case 'toggle-favorite': {
        const game = state.modal.game;
        const updated = await api.library.favorite(game.id, !game.favorite);
        state.modal.game = updated;
        state.games = state.games.map((entry) => (entry.id === updated.id ? updated : entry));
        renderGameModal();
        renderView();
        return;
      }
      case 'scrape': {
        const game = state.modal.game;
        toast('Consultando provedor de metadados...', { title: 'Metadados' });
        await api.metadata.scrape(game.id);
        const [updated, games] = await Promise.all([
          api.library.get(game.id),
          api.library.list({
            search: state.filters.search,
            platformId: state.filters.platform,
            limit: 300,
          }),
        ]);
        state.modal.game = updated;
        state.games = games;
        renderGameModal();
        renderView();
        toast('Capa e sinopse atualizadas.', { title: 'Metadados' });
        return;
      }
      case 'remove-game': {
        const game = state.modal.game;
        const confirmed = await askConfirm({
          title: 'Remover da biblioteca?',
          message:
            'A entrada e os save states serão removidos do banco. O arquivo ROM/ISO NÃO será apagado do disco.',
          confirmLabel: 'Remover entrada',
          danger: true,
        });
        if (!confirmed) return;
        closeModal({ resolve: false });
        await api.library.remove(game.id);
        state.games = state.games.filter((entry) => entry.id !== game.id);
        await refreshLibraryData();
        toast('Jogo removido da biblioteca. Arquivo preservado.', { title: 'Biblioteca' });
        return;
      }
      case 'link-ra': {
        const input = $('#raGameId');
        const value = Number(input?.value);
        if (!Number.isInteger(value) || value <= 0) {
          toast('Informe um ID numérico válido.', { type: 'warn' });
          return;
        }
        await api.retroachievements.linkGame(state.modal.game.id, value);
        toast('Jogo vinculado ao RetroAchievements.', { title: 'Conquistas' });
        return;
      }
      case 'sync-ra':
        await api.retroachievements.syncAchievements(state.modal.game.id);
        toast('Conquistas sincronizadas.', { title: 'RetroAchievements' });
        return;
      case 'install-core':
        await installCore(actionElement.dataset.core);
        return;
      case 'open-core-site':
        await api.cores.openSite(actionElement.dataset.core);
        return;
      case 'open-saves':
        await api.app.openPath('saves');
        return;
      case 'open-logs':
        await api.app.openPath('logs');
        return;
      case 'open-data':
        await api.app.openPath('data');
        return;
      case 'reveal-cores':
        await api.cores.revealConfig();
        return;
      case 'confirm-yes':
      case 'confirm-stop': {
        const resolve = state.confirmResolve;
        state.confirmResolve = null;
        resolve?.(true);
        return;
      }
      case 'confirm-no': {
        const resolve = state.confirmResolve;
        state.confirmResolve = null;
        resolve?.(false);
        return;
      }
      case 'close-modal':
        closeModal();
        return;
      default:
        return;
    }
  } catch (error) {
    handleError(error);
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === 'raConnectForm') {
      const data = new FormData(form);
      state.ra = await api.retroachievements.connect({
        username: data.get('username'),
        apiKey: data.get('apiKey'),
      });
      syncShell();
      renderView();
      toast('Conta conectada. Hardcore está disponível.', { title: 'RetroAchievements' });
      return;
    }
    if (form.id === 'customBiosForm') {
      const data = new FormData(form);
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const imported = await api.bios.chooseAndImportCustom({
          platformId: data.get('platformId'),
          region: data.get('region'),
          kind: data.get('kind'),
          label: data.get('label'),
          acknowledged: data.get('acknowledged') === 'on',
        });
        if (!imported) return;
        closeModal();
        [state.bios, state.matrix] = await Promise.all([api.bios.list(), api.bios.matrix()]);
        syncShell();
        renderView();
        toast(`“${imported.label}” importada e revalidada por hash.`, {
          title: imported.isCustom ? 'BIOS personalizada' : 'BIOS importada',
        });
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
      return;
    }
    if (form.id === 'keyboardProfileForm') {
      const data = new FormData(form);
      await api.controllers.saveProfile({
        playerIndex: Number(data.get('playerIndex')),
        name: data.get('name'),
        api: 'keyboard',
        hardwareGuid: null,
      });
      state.profiles = await api.controllers.profiles();
      closeModal();
      renderView();
      toast('Perfil de teclado criado.', { title: 'Controles' });
      return;
    }
    if (form.id === 'mappingForm') {
      const mapping = {};
      for (const [key, value] of new FormData(form).entries()) mapping[key] = value;
      await api.controllers.setMapping(form.dataset.profile, mapping);
      state.profiles = await api.controllers.profiles();
      closeModal();
      renderView();
      toast('Mapeamento salvo.', { title: 'Controles' });
      return;
    }
    if (form.dataset.metadataForm) {
      const data = Object.fromEntries(new FormData(form).entries());
      state.metadata = await api.metadata.setCredentials(form.dataset.metadataForm, data);
      renderView();
      toast('Credenciais cifradas e salvas.', { title: 'Metadados' });
    }
  } catch (error) {
    handleError(error);
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  try {
    if (target.matches('[data-setting]')) {
      let value = target.type === 'checkbox' ? target.checked : target.value;
      if (target.type === 'number') value = Number(value);
      state.settings = await api.settings.set(target.dataset.setting, value);
      return;
    }
    if (target.id === 'customBiosPlatform') {
      refreshCustomBiosSelectors({ keepSelection: false });
      return;
    }
    if (target.id === 'gamePlatform') {
      const id = target.dataset.game;
      const updated = await api.library.platform(id, target.value);
      state.modal.game = updated;
      state.games = state.games.map((game) => (game.id === updated.id ? updated : game));
      renderGameModal();
      renderView();
      toast(`Plataforma alterada para ${updated.platformName}.`, { title: 'Biblioteca' });
      return;
    }
    if (target.id === 'gameRegion') {
      if (!target.value) return;
      const id = target.dataset.region;
      const updated = await api.library.region(id, target.value);
      state.modal.game = updated;
      state.games = state.games.map((game) => (game.id === updated.id ? updated : game));
      renderGameModal();
      renderView();
      toast('Região atualizada. A BIOS correspondente será exigida no próximo boot.', { title: 'Região' });
    }
  } catch (error) {
    handleError(error);
  }
});

$('#globalSearch').addEventListener(
  'input',
  debounce(async (event) => {
    state.filters.search = event.target.value.trim();
    if (state.view !== 'library') {
      state.view = 'library';
      syncShell();
    }
    try {
      state.games = await api.library.list({
        search: state.filters.search,
        platformId: state.filters.platform,
        limit: 300,
      });
      renderView();
    } catch (error) {
      handleError(error);
    }
  }, 240),
);

function initTheme() {
  let theme = 'dark';
  try {
    const saved = localStorage.getItem('w3labs-theme');
    if (saved === 'light' || saved === 'dark') {
      theme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
  } catch {
    // localStorage indisponível
  }
  applyTheme(theme);
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  const toggleBtn = $('#themeToggle');
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-pressed', String(isDark));
    toggleBtn.title = isDark ? 'Alternar para tema claro' : 'Alternar para tema escuro';
    toggleBtn.setAttribute('aria-label', isDark ? 'Alternar para tema claro' : 'Alternar para tema escuro');
  }
  const metaTheme = $('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.content = isDark ? '#07090d' : '#f2f3ef';
  }
  try {
    localStorage.setItem('w3labs-theme', isDark ? 'dark' : 'light');
  } catch {
    // localStorage indisponível
  }
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

$('#themeToggle')?.addEventListener('click', toggleTheme);
$('#refreshButton').addEventListener('click', refreshCurrentView);
$('#raTopChip').addEventListener('click', () => switchView('achievements'));
$('#sidebarHardcore').addEventListener('click', () => toggleHardcore(!state.ra?.hardcore));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modal) closeModal();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('#globalSearch').focus();
  }
});

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ── Assinaturas IPC ────────────────────────────── */

api.library.onScanProgress((progress) => {
  if (!state.scan?.active) return;
  const dock = $('#scanDock');
  dock.hidden = false;
  if (progress.phase === 'walking') {
    $('#scanDetail').textContent =
      `${progress.filesSeen} arquivos vistos · ${progress.queued} mídias na fila`;
    $('#scanPercent').textContent = '…';
    $('#scanProgress').style.width = '8%';
  } else if (progress.phase === 'hashing-media') {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    $('#scanTitle').textContent = progress.largeFile
      ? 'Hash em streaming · arquivo > 2 GB'
      : 'Calculando hashes';
    $('#scanDetail').textContent =
      `${progress.currentFile ?? ''} · ${formatBytes(progress.bytes)} de ${formatBytes(progress.totalBytes)}`;
    $('#scanPercent').textContent = `${percent}%`;
    $('#scanProgress').style.width = `${Math.max(4, percent)}%`;
  } else if (progress.phase === 'hashing') {
    const percent = progress.total ? Math.round((progress.hashed / progress.total) * 100) : 0;
    $('#scanTitle').textContent = progress.largeFile
      ? 'Hash em streaming (arquivo > 2 GB)'
      : 'Calculando hashes';
    $('#scanDetail').textContent = `${progress.currentFile ?? ''}`;
    $('#scanPercent').textContent = `${percent}%`;
    $('#scanProgress').style.width = `${Math.max(4, percent)}%`;
  } else if (progress.phase === 'root-done') {
    $('#scanDetail').textContent = `${progress.indexed} jogos indexados nesta pasta`;
    $('#scanProgress').style.width = '94%';
  } else if (progress.phase === 'done') {
    $('#scanProgress').style.width = '100%';
    $('#scanPercent').textContent = '100%';
  }
});

api.emulation.onChanged((session) => {
  const hadSession = Boolean(state.active);
  state.active = session;
  renderActiveStrip();
  syncShell();
  if (session) {
    if (state.modal?.type === 'game' && state.modal.game.id === session.gameId) renderGameModal();
  } else if (hadSession) {
    toast('Sessão encerrada.', { title: 'Emulação' });
    if (state.modal?.type === 'game') renderGameModal();
  }
});

api.emulation.onCoreEvent((payload) => {
  if (payload?.event === 'error') {
    toast(payload.payload?.message ?? 'Erro no núcleo.', { title: 'Núcleo', type: 'error' });
  }
});

api.retroachievements.onChanged((ra) => {
  state.ra = ra;
  syncShell();
  if (state.view === 'achievements') renderView();
  if (state.modal?.type === 'game') renderGameModal();
});

api.bios.onChanged((matrix) => {
  state.matrix = matrix;
  syncShell();
  if (state.view === 'bios') refreshCurrentView();
});

api.cores.onInstallProgress((progress) => {
  updateInstallProgressUI(progress);
});

api.cores.onChanged(async (catalog) => {
  state.installCatalog = catalog;
  state.cores = await api.cores.status().catch(() => state.cores);
  if (state.view === 'settings') renderView();
  if (state.modal?.type === 'install-core') {
    const entry = catalog.find((item) => item.coreId === state.modal.coreId);
    if (entry?.installed) closeModal();
  }
});

initTheme();
loadInitial();
