const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const TOKEN_STORAGE_KEY = 'rifa_admin_token';
const VALOR_NUMERO_CENTAVOS = 1000; // R$10,00 fixo por número (ver schema.sql)

const modalLogin = document.getElementById('modal-login');
const formLogin = document.getElementById('form-login');
const inputToken = document.getElementById('input-token');
const loginErroEl = document.getElementById('login-erro');
const btnEntrar = document.getElementById('btn-entrar');
const painelEl = document.getElementById('painel');
const btnSair = document.getElementById('btn-sair');
const listaEl = document.getElementById('lista-compradores');
const ultimaAtualizacaoEl = document.getElementById('ultima-atualizacao');
const buscaEl = document.getElementById('busca');
const btnAtualizar = document.getElementById('btn-atualizar');
const filtroBtns = document.querySelectorAll('.filtro-btn');

const statCompradoresEl = document.getElementById('stat-compradores');
const statVendidosEl = document.getElementById('stat-vendidos');
const statPendentesEl = document.getElementById('stat-pendentes');
const statArrecadadoEl = document.getElementById('stat-arrecadado');

const btnSorteio = document.getElementById('btn-sorteio');
const modalSorteio = document.getElementById('modal-sorteio');
const sorteioIntroEl = document.getElementById('sorteio-intro');
const sorteioIntroTextoEl = document.getElementById('sorteio-intro-texto');
const btnSorteioCancelar = document.getElementById('btn-sorteio-cancelar');
const btnSorteioIniciar = document.getElementById('btn-sorteio-iniciar');
const sorteioPalcoEl = document.getElementById('sorteio-palco');
const sorteioMedalhaEl = document.getElementById('sorteio-medalha');
const sorteioTituloPremioEl = document.getElementById('sorteio-titulo-premio');
const sorteioNumeroEl = document.getElementById('sorteio-numero');
const sorteioNomeEl = document.getElementById('sorteio-nome');
const sorteioTelefoneEl = document.getElementById('sorteio-telefone');
const sorteioResultadoEl = document.getElementById('sorteio-resultado');
const sorteioListaVencedoresEl = document.getElementById('sorteio-lista-vencedores');
const btnSorteioFechar = document.getElementById('btn-sorteio-fechar');
const btnSorteioProximo = document.getElementById('btn-sorteio-proximo');

// Ordem de revelação: do prêmio menor pro maior, guardando a Smart TV pro final
// (mais suspense). A medalha de cada item reflete a colocação real do prêmio, não
// a ordem em que é sorteado.
const PREMIOS = [
  { medalha: '🥉', titulo: 'Copo Térmico' },
  { medalha: '🥈', titulo: 'Kit de Beleza' },
  { medalha: '🥇', titulo: 'Smart TV 32"' },
];

let reservasCache = [];
let filtroAtivo = 'todos';

function formatarNumero(numero) {
  return String(numero).padStart(4, '0');
}

function formatarMoeda(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarData(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function apenasDigitos(texto) {
  return (texto || '').replace(/\D/g, '');
}

async function buscarReservas(token) {
  const { data, error } = await supabaseClient.rpc('listar_reservas_admin', { p_admin_token: token });
  if (error) throw error;
  return data;
}

function agruparPorComprador(reservas) {
  const grupos = new Map();
  for (const r of reservas) {
    const chave = r.whatsapp || r.nome;
    if (!grupos.has(chave)) {
      grupos.set(chave, { nome: r.nome, whatsapp: r.whatsapp, numeros: [] });
    }
    grupos.get(chave).numeros.push(r);
  }
  // Ordena cada grupo pelo número, e os grupos pela compra mais recente
  const lista = [...grupos.values()];
  for (const g of lista) {
    g.numeros.sort((a, b) => a.numero - b.numero);
    g.ultimaCompra = g.numeros.reduce((max, n) => (n.criada_em > max ? n.criada_em : max), g.numeros[0].criada_em);
  }
  lista.sort((a, b) => (a.ultimaCompra < b.ultimaCompra ? 1 : -1));
  return lista;
}

function atualizarStats(reservas) {
  const compradores = new Set(reservas.map((r) => r.whatsapp || r.nome)).size;
  const vendidos = reservas.filter((r) => r.status === 'paga').length;
  const pendentes = reservas.filter((r) => r.status === 'pendente').length;

  statCompradoresEl.textContent = String(compradores);
  statVendidosEl.textContent = String(vendidos);
  statPendentesEl.textContent = String(pendentes);
  statArrecadadoEl.textContent = formatarMoeda(vendidos * VALOR_NUMERO_CENTAVOS);
}

function statusLabel(status) {
  if (status === 'paga') return 'Pago';
  if (status === 'pendente') return 'Pendente';
  if (status === 'expirada') return 'Expirado';
  if (status === 'cancelada') return 'Cancelado';
  return status;
}

function criarCardComprador(grupo) {
  const card = document.createElement('article');
  card.className = 'comprador-card';

  const info = document.createElement('div');
  info.className = 'comprador-info';

  const nomeEl = document.createElement('h3');
  nomeEl.textContent = grupo.nome;
  info.appendChild(nomeEl);

  if (grupo.whatsapp) {
    const whatsLink = document.createElement('a');
    whatsLink.className = 'comprador-whatsapp';
    whatsLink.href = `https://wa.me/${apenasDigitos(grupo.whatsapp)}`;
    whatsLink.target = '_blank';
    whatsLink.rel = 'noopener';
    whatsLink.textContent = `📱 ${grupo.whatsapp}`;
    info.appendChild(whatsLink);
  }

  const dataEl = document.createElement('span');
  dataEl.className = 'comprador-data';
  dataEl.textContent = `Última compra: ${formatarData(grupo.ultimaCompra)}`;
  info.appendChild(dataEl);

  card.appendChild(info);

  const numerosEl = document.createElement('div');
  numerosEl.className = 'comprador-numeros';
  for (const r of grupo.numeros) {
    if (filtroAtivo !== 'todos' && r.status !== filtroAtivo) continue;
    const chip = document.createElement('span');
    chip.className = `numero-chip ${r.status}`;
    chip.textContent = `${formatarNumero(r.numero)} · ${statusLabel(r.status)}`;
    numerosEl.appendChild(chip);
  }
  if (!numerosEl.children.length) return null;
  card.appendChild(numerosEl);

  return card;
}

function renderizarLista() {
  const termo = buscaEl.value.trim().toLowerCase();
  const grupos = agruparPorComprador(reservasCache);

  listaEl.replaceChildren();
  let algumVisivel = false;

  for (const grupo of grupos) {
    const combinado = `${grupo.nome} ${grupo.whatsapp} ${grupo.numeros.map((n) => formatarNumero(n.numero)).join(' ')}`.toLowerCase();
    if (termo && !combinado.includes(termo)) continue;

    const card = criarCardComprador(grupo);
    if (!card) continue;
    listaEl.appendChild(card);
    algumVisivel = true;
  }

  if (!algumVisivel) {
    const vazio = document.createElement('p');
    vazio.className = 'lista-vazia';
    vazio.textContent = 'Nenhum comprador encontrado.';
    listaEl.appendChild(vazio);
  }
}

const AUTO_REFRESH_MS = 15000;
let autoRefreshTimer = null;

// silencioso=true (usado pelo auto-refresh) não mostra "Carregando..." nem mexe no
// scroll/estado da busca — só troca os dados por baixo, pra não piscar a tela nem
// atrapalhar quem está digitando na busca.
async function carregarPainel(silencioso = false) {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return false;

  try {
    if (!silencioso) {
      listaEl.replaceChildren();
      const carregando = document.createElement('p');
      carregando.className = 'carregando';
      carregando.textContent = 'Carregando compradores...';
      listaEl.appendChild(carregando);
    }

    reservasCache = await buscarReservas(token);
    atualizarStats(reservasCache);
    renderizarLista();
    modalLogin.close();
    painelEl.hidden = false;
    ultimaAtualizacaoEl.textContent = `Atualizado automaticamente às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

    if (!autoRefreshTimer) {
      autoRefreshTimer = setInterval(() => carregarPainel(true), AUTO_REFRESH_MS);
    }
    return true;
  } catch (error) {
    console.error('Falha ao carregar painel', { error });
    if (!silencioso) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      painelEl.hidden = true;
    }
    return false;
  }
}

formLogin.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginErroEl.textContent = '';
  btnEntrar.disabled = true;

  const token = inputToken.value.trim();
  localStorage.setItem(TOKEN_STORAGE_KEY, token);

  const ok = await carregarPainel();
  if (!ok) {
    loginErroEl.textContent = 'Código de acesso incorreto.';
    inputToken.value = '';
    inputToken.focus();
  }
  btnEntrar.disabled = false;
});

btnSair.addEventListener('click', () => {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  painelEl.hidden = true;
  inputToken.value = '';
  modalLogin.showModal();
});

btnAtualizar.addEventListener('click', () => carregarPainel());

buscaEl.addEventListener('input', renderizarLista);

filtroBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    filtroBtns.forEach((b) => b.classList.remove('ativo'));
    btn.classList.add('ativo');
    filtroAtivo = btn.dataset.filtro;
    renderizarLista();
  });
});

// Embaralha com Fisher-Yates usando crypto.getRandomValues (mais imparcial que
// Math.random pra decidir quem ganha prêmio de verdade).
function embaralhar(lista) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

function dispararConfeteSorteio() {
  const canvas = document.createElement('canvas');
  canvas.className = 'sorteio-confete-canvas';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  modalSorteio.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const cores = ['#f472b6', '#db2777', '#e5c158', '#d4af37', '#ffffff'];
  const particulas = Array.from({ length: 160 }, () => ({
    x: canvas.width / 2,
    y: canvas.height / 3,
    vx: (Math.random() - 0.5) * 16,
    vy: Math.random() * -15 - 5,
    tamanho: Math.random() * 6 + 4,
    cor: cores[Math.floor(Math.random() * cores.length)],
    rotacao: Math.random() * Math.PI * 2,
    vRotacao: (Math.random() - 0.5) * 0.3,
    gravidade: 0.35,
    vida: 0,
    vidaMax: 90 + Math.random() * 30,
  }));

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let ativas = false;
    for (const p of particulas) {
      if (p.vida >= p.vidaMax) continue;
      ativas = true;
      p.vida += 1;
      p.vx *= 0.99;
      p.vy += p.gravidade;
      p.x += p.vx;
      p.y += p.vy;
      p.rotacao += p.vRotacao;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.vida / p.vidaMax);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotacao);
      ctx.fillStyle = p.cor;
      ctx.fillRect(-p.tamanho / 2, -p.tamanho / 4, p.tamanho, p.tamanho / 2);
      ctx.restore();
    }
    if (ativas) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}

function poolElegivel() {
  return reservasCache.filter((r) => r.status === 'paga');
}

btnSorteio.addEventListener('click', () => {
  const pool = poolElegivel();
  sorteioIntroEl.hidden = false;
  sorteioPalcoEl.hidden = true;
  sorteioResultadoEl.hidden = true;

  if (pool.length === 0) {
    sorteioIntroTextoEl.textContent = 'Ainda não tem nenhum número pago pra sortear.';
    btnSorteioIniciar.hidden = true;
  } else {
    const qtdPremios = Math.min(PREMIOS.length, pool.length);
    sorteioIntroTextoEl.textContent = `${pool.length} número${pool.length > 1 ? 's' : ''} pago${pool.length > 1 ? 's' : ''} concorrendo. Vamos sortear ${qtdPremios} prêmio${qtdPremios > 1 ? 's' : ''}.`;
    btnSorteioIniciar.hidden = false;
  }

  modalSorteio.showModal();
});

btnSorteioCancelar.addEventListener('click', () => modalSorteio.close());
btnSorteioFechar.addEventListener('click', () => modalSorteio.close());

// Sorteio manual, prêmio por prêmio: a cliente controla o ritmo (útil numa live).
// Os vencedores já ficam definidos assim que ela clica em "Sortear agora" (pra não
// mudar de resultado se ela recarregar a lista no meio do sorteio), mas cada
// revelação individual só acontece quando ela clica no botão daquele prêmio.
const sorteioEstado = { sorteados: [], indice: 0 };

btnSorteioIniciar.addEventListener('click', () => {
  const pool = poolElegivel();
  const qtdPremios = Math.min(PREMIOS.length, pool.length);
  sorteioEstado.sorteados = embaralhar(pool).slice(0, qtdPremios);
  sorteioEstado.indice = 0;

  sorteioIntroEl.hidden = true;
  sorteioResultadoEl.hidden = true;
  sorteioPalcoEl.hidden = false;

  prepararProximoPremio();
});

function ultimosDigitosTelefone(whatsapp) {
  const digitos = (whatsapp || '').replace(/\D/g, '');
  return digitos.slice(-4) || '----';
}

function prepararProximoPremio() {
  const { sorteados, indice } = sorteioEstado;
  if (indice >= sorteados.length) {
    mostrarResultadoFinal(sorteados);
    return;
  }

  const premio = PREMIOS[indice];
  sorteioMedalhaEl.textContent = premio.medalha;
  sorteioTituloPremioEl.textContent = premio.titulo;
  sorteioNumeroEl.classList.remove('girando');
  sorteioNomeEl.classList.remove('girando');
  sorteioNumeroEl.textContent = '????';
  sorteioNomeEl.textContent = 'Clique pra sortear';
  sorteioTelefoneEl.textContent = '';
  btnSorteioProximo.hidden = false;
  btnSorteioProximo.textContent = `🎲 Sortear ${premio.titulo}`;
  btnSorteioProximo.onclick = executarSorteioAtual;
}

// Sorteia e revela o prêmio atual. Depois de travar no vencedor (nome + 4 últimos
// dígitos do telefone, bem destacados), NÃO avança sozinho -- fica parado até a
// cliente clicar em "Continuar", dando tempo dela anunciar o ganhador numa live
// antes de seguir pro próximo prêmio.
function executarSorteioAtual() {
  btnSorteioProximo.hidden = true;

  const { sorteados, indice } = sorteioEstado;
  const vencedor = sorteados[indice];
  const poolTodo = poolElegivel();

  sorteioNumeroEl.classList.add('girando');
  sorteioNomeEl.classList.add('girando');

  const duracaoMs = 5000;
  const inicio = performance.now();

  function ciclo(agora) {
    const decorrido = agora - inicio;
    if (decorrido < duracaoMs) {
      const candidato = poolTodo[Math.floor(Math.random() * poolTodo.length)];
      sorteioNumeroEl.textContent = formatarNumero(candidato.numero);
      sorteioNomeEl.textContent = candidato.nome;
      sorteioTelefoneEl.textContent = `📱 final ${ultimosDigitosTelefone(candidato.whatsapp)}`;
      requestAnimationFrame(ciclo);
    } else {
      sorteioNumeroEl.classList.remove('girando');
      sorteioNomeEl.classList.remove('girando');
      sorteioNumeroEl.textContent = formatarNumero(vencedor.numero);
      sorteioNomeEl.textContent = vencedor.nome;
      sorteioTelefoneEl.textContent = `📱 final ${ultimosDigitosTelefone(vencedor.whatsapp)}`;
      dispararConfeteSorteio();
      sorteioEstado.indice += 1;

      const haProximoPremio = sorteioEstado.indice < sorteados.length;
      setTimeout(() => {
        btnSorteioProximo.hidden = false;
        btnSorteioProximo.textContent = haProximoPremio ? '➡️ Continuar' : '🏆 Ver Resultado Final';
        btnSorteioProximo.onclick = haProximoPremio
          ? prepararProximoPremio
          : () => mostrarResultadoFinal(sorteados);
      }, 600);
    }
  }
  requestAnimationFrame(ciclo);
}

function mostrarResultadoFinal(sorteados) {
  sorteioPalcoEl.hidden = true;
  sorteioResultadoEl.hidden = false;
  sorteioListaVencedoresEl.replaceChildren();

  sorteados.forEach((vencedor, indice) => {
    const item = document.createElement('li');
    item.innerHTML = `
      <span class="sorteio-resultado-medalha">${PREMIOS[indice].medalha}</span>
      <div class="sorteio-resultado-info">
        <strong>${vencedor.nome}</strong>
        <span>Número ${formatarNumero(vencedor.numero)} · ${PREMIOS[indice].titulo}</span>
      </div>
    `;
    sorteioListaVencedoresEl.appendChild(item);
  });
}

(async function iniciar() {
  const autenticado = await carregarPainel();
  if (!autenticado) {
    modalLogin.showModal();
  }
})();
