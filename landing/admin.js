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
const buscaEl = document.getElementById('busca');
const btnAtualizar = document.getElementById('btn-atualizar');
const filtroBtns = document.querySelectorAll('.filtro-btn');

const statCompradoresEl = document.getElementById('stat-compradores');
const statVendidosEl = document.getElementById('stat-vendidos');
const statPendentesEl = document.getElementById('stat-pendentes');
const statArrecadadoEl = document.getElementById('stat-arrecadado');

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

async function carregarPainel() {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return false;

  try {
    listaEl.replaceChildren();
    const carregando = document.createElement('p');
    carregando.className = 'carregando';
    carregando.textContent = 'Carregando compradores...';
    listaEl.appendChild(carregando);

    reservasCache = await buscarReservas(token);
    atualizarStats(reservasCache);
    renderizarLista();
    modalLogin.close();
    painelEl.hidden = false;
    return true;
  } catch (error) {
    console.error('Falha ao carregar painel', { error });
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    painelEl.hidden = true;
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

(async function iniciar() {
  const autenticado = await carregarPainel();
  if (!autenticado) {
    modalLogin.showModal();
  }
})();
