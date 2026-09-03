const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const gridEl = document.getElementById('grid');
const modalCompra = document.getElementById('modal-compra');
const modalPix = document.getElementById('modal-pix');
const formCompra = document.getElementById('form-compra');
const modalNumeroEl = document.getElementById('modal-numero');
const modalErroEl = document.getElementById('modal-erro');
const inputNome = document.getElementById('input-nome');
const inputWhatsapp = document.getElementById('input-whatsapp');
const inputCpf = document.getElementById('input-cpf');
const btnGerarPix = document.getElementById('btn-gerar-pix');
const btnCancelar = document.getElementById('btn-cancelar');
const btnFecharPix = document.getElementById('btn-fechar-pix');
const btnCopiarPix = document.getElementById('btn-copiar-pix');
const pixQrcodeEl = document.getElementById('pix-qrcode');
const pixCopiaColaEl = document.getElementById('pix-copiacola');
const pixStatusEl = document.getElementById('pix-status');
const fallbackChavePixEl = document.getElementById('fallback-chave-pix');
const fallbackWhatsappEl = document.getElementById('fallback-whatsapp');

let numeroSelecionado = null;
let pollTimer = null;

// Estado em memória usado só quando CONFIG.MOCK_MODE = true — deixa a página inteira
// demonstrável sem Supabase nem Efí configurados ainda (ver README).
const mockStore = {
  numeros: new Map(),
  reservas: new Map(),
};

function inicializarMockGrid() {
  for (let numero = 1; numero <= CONFIG.TOTAL_NUMEROS; numero += 1) {
    mockStore.numeros.set(numero, 'disponivel');
  }
  [7, 13, 42, 100, 250, 777, 1000].forEach((numero) => mockStore.numeros.set(numero, 'pago'));
}

function gerarQrcodeMockBase64() {
  const canvas = document.createElement('canvas');
  canvas.width = 220;
  canvas.height = 220;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 220, 220);
  ctx.strokeStyle = '#0f0f14';
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, 200, 200);
  ctx.fillStyle = '#0f0f14';
  ctx.font = 'bold 16px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('QR CODE', 110, 100);
  ctx.fillText('(simulado)', 110, 125);
  return canvas.toDataURL('image/png').split(',')[1];
}

function formatarNumero(numero) {
  return String(numero).padStart(4, '0');
}

function apenasDigitos(texto) {
  return texto.replace(/\D/g, '');
}

function cpfValido(texto) {
  return apenasDigitos(texto).length === 11;
}

function criarCelula(numero, status) {
  const cel = document.createElement('button');
  cel.type = 'button';
  cel.className = `numero ${status}`;
  cel.textContent = formatarNumero(numero);
  cel.dataset.numero = String(numero);
  cel.dataset.status = status;
  // Sem `disabled` de propósito: um <button disabled> não dispara evento de clique
  // nenhum, então quem clicasse num número reservado/pago não via nenhuma mensagem.
  cel.addEventListener('click', () => {
    if (cel.dataset.status !== 'disponivel') {
      alert(
        cel.dataset.status === 'reservado'
          ? 'Esse número está em processo de pagamento por outra pessoa. Tente novamente em alguns minutos.'
          : 'Esse número já foi vendido.'
      );
      return;
    }
    abrirModalCompra(numero);
  });
  return cel;
}

async function carregarGrid() {
  if (CONFIG.MOCK_MODE) {
    gridEl.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const [numero, status] of mockStore.numeros) {
      fragment.appendChild(criarCelula(numero, status));
    }
    gridEl.appendChild(fragment);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('numeros')
      .select('numero, status')
      .order('numero', { ascending: true });

    if (error) throw error;

    gridEl.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const linha of data) {
      fragment.appendChild(criarCelula(linha.numero, linha.status));
    }
    gridEl.appendChild(fragment);
  } catch (error) {
    console.error('Falha ao carregar grade de números', { error });
    gridEl.textContent = 'Não foi possível carregar os números agora. Recarregue a página.';
  }
}

function atualizarCelula(numero, status) {
  const cel = gridEl.querySelector(`[data-numero="${numero}"]`);
  if (!cel) return;
  cel.className = `numero ${status}`;
  cel.dataset.status = status;
}

function assinarAtualizacoesEmTempoReal() {
  if (CONFIG.MOCK_MODE) return;

  supabaseClient
    .channel('numeros-mudancas')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'numeros' },
      (payload) => atualizarCelula(payload.new.numero, payload.new.status)
    )
    .subscribe();
}

function abrirModalCompra(numero) {
  numeroSelecionado = numero;
  modalNumeroEl.textContent = formatarNumero(numero);
  modalErroEl.textContent = '';
  inputNome.value = '';
  inputWhatsapp.value = '';
  inputCpf.value = '';
  modalCompra.showModal();
}

async function reservarNumero(numero, nome, whatsapp, cpf) {
  const resposta = await fetch(CONFIG.MAKE_WEBHOOK_RESERVAR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numero, nome, whatsapp, cpf: apenasDigitos(cpf) }),
  });

  if (!resposta.ok) {
    throw new Error(`Webhook de reserva retornou status ${resposta.status}`);
  }

  return resposta.json();
}

async function reservarNumeroMock(numero, nome, whatsapp, cpf) {
  await new Promise((resolve) => setTimeout(resolve, 500)); // simula latência de rede

  if (mockStore.numeros.get(numero) !== 'disponivel') {
    return { sucesso: false, motivo: 'numero_indisponivel' };
  }

  const reservaId = crypto.randomUUID();
  mockStore.numeros.set(numero, 'reservado');
  mockStore.reservas.set(reservaId, { numero, status: 'pendente' });
  atualizarCelula(numero, 'reservado');

  return {
    sucesso: true,
    reserva_id: reservaId,
    qrcode_base64: gerarQrcodeMockBase64(),
    copia_cola: '00020126580014BR.GOV.BCB.PIX-MOCK-NAO-USE-PARA-PAGAMENTO-REAL',
  };
}

formCompra.addEventListener('submit', async (event) => {
  event.preventDefault();
  modalErroEl.textContent = '';

  if (!cpfValido(inputCpf.value)) {
    modalErroEl.textContent = 'Informe um CPF válido (11 dígitos) — é exigido para gerar a cobrança PIX.';
    return;
  }

  btnGerarPix.disabled = true;

  try {
    const reservar = CONFIG.MOCK_MODE ? reservarNumeroMock : reservarNumero;
    const resultado = await reservar(
      numeroSelecionado,
      inputNome.value.trim(),
      inputWhatsapp.value.trim(),
      inputCpf.value.trim()
    );

    if (!resultado.sucesso) {
      modalErroEl.textContent =
        resultado.motivo === 'numero_indisponivel'
          ? 'Esse número acabou de ser reservado por outra pessoa. Escolha outro.'
          : 'Não foi possível gerar o PIX agora. Tente novamente em instantes.';
      await carregarGrid();
      return;
    }

    modalCompra.close();
    abrirModalPix(resultado);
  } catch (error) {
    console.error('Falha ao reservar número', { error, numero: numeroSelecionado });
    modalErroEl.textContent = 'Erro de conexão. Verifique sua internet e tente novamente.';
  } finally {
    btnGerarPix.disabled = false;
  }
});

btnCancelar.addEventListener('click', () => modalCompra.close());

function abrirModalPix(resultado) {
  pixQrcodeEl.src = `data:image/png;base64,${resultado.qrcode_base64}`;
  pixCopiaColaEl.value = resultado.copia_cola;
  fallbackChavePixEl.textContent = CONFIG.PIX_CHAVE_FALLBACK;
  fallbackWhatsappEl.textContent = CONFIG.WHATSAPP_FALLBACK;
  fallbackWhatsappEl.href = `https://wa.me/${CONFIG.WHATSAPP_FALLBACK}?text=${encodeURIComponent(
    `Oi! Fiz o PIX manual pro número ${formatarNumero(numeroSelecionado)}, segue o comprovante.`
  )}`;
  pixStatusEl.textContent = 'Aguardando pagamento...';
  pixStatusEl.className = 'status-espera';
  modalPix.showModal();
  iniciarPollDeStatus(resultado.reserva_id);
}

function iniciarPollDeStatus(reservaId) {
  pararPoll();

  if (CONFIG.MOCK_MODE) {
    // setTimeout aqui é intencional — pararPoll() usa clearInterval, que no navegador
    // cancela tanto ids de setInterval quanto de setTimeout (mesmo contador interno).
    pollTimer = setTimeout(() => {
      const reserva = mockStore.reservas.get(reservaId);
      if (!reserva) return;
      reserva.status = 'paga';
      mockStore.numeros.set(reserva.numero, 'pago');
      atualizarCelula(reserva.numero, 'pago');
      pixStatusEl.textContent = 'Pagamento confirmado! Seu número está garantido. (simulado)';
      pixStatusEl.className = 'status-sucesso';
      dispararConfete();
    }, 5000);
    return;
  }

  pollTimer = setInterval(async () => {
    try {
      // RPC, não select direto: `reservas` tem RLS sem policy de leitura pública (só
      // exporia nome/whatsapp/cpf pra chave anon). status_reserva() é SECURITY DEFINER
      // e devolve só o status (ver supabase/schema.sql).
      const { data: status, error } = await supabaseClient.rpc('status_reserva', {
        p_reserva_id: reservaId,
      });

      if (error) throw error;

      if (status === 'paga') {
        pixStatusEl.textContent = 'Pagamento confirmado! Seu número está garantido.';
        pixStatusEl.className = 'status-sucesso';
        dispararConfete();
        pararPoll();
        await carregarGrid();
      } else if (status === 'expirada' || status === 'cancelada') {
        pixStatusEl.textContent = 'O tempo para pagamento expirou. Escolha o número novamente.';
        pixStatusEl.className = 'status-erro';
        pararPoll();
        await carregarGrid();
      }
    } catch (error) {
      console.error('Falha ao consultar status da reserva', { error, reservaId });
    }
  }, CONFIG.POLL_INTERVALO_MS);
}

function dispararConfete() {
  // Anexa dentro do <dialog> aberto (não em document.body): dialogs nativos
  // renderizam numa "top layer" acima de qualquer elemento normal — um canvas
  // fixed em body ficaria escondido atrás do modal por maior que fosse o z-index.
  const dialogAberto = document.querySelector('dialog[open]') ?? document.body;
  const canvas = document.createElement('canvas');
  canvas.id = 'confete-canvas';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  dialogAberto.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const cores = ['#f472b6', '#db2777', '#e5c158', '#d4af37', '#ffffff'];
  const particulas = Array.from({ length: 140 }, () => ({
    x: canvas.width / 2,
    y: canvas.height / 3,
    vx: (Math.random() - 0.5) * 14,
    vy: Math.random() * -14 - 4,
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

function pararPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

btnFecharPix.addEventListener('click', () => {
  pararPoll();
  modalPix.close();
});

btnCopiarPix.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pixCopiaColaEl.value);
    btnCopiarPix.textContent = 'Copiado!';
    setTimeout(() => (btnCopiarPix.textContent = 'Copiar código'), 2000);
  } catch (error) {
    console.error('Falha ao copiar código PIX', { error });
  }
});

if (CONFIG.MOCK_MODE) {
  inicializarMockGrid();
}

carregarGrid();
assinarAtualizacoesEmTempoReal();
