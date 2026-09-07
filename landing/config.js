// Preencha com os valores reais antes de publicar.
// SUPABASE_ANON_KEY é uma chave pública (somente leitura, protegida por RLS) — pode
// ficar exposta no front-end. NUNCA coloque a service_role key aqui.
const CONFIG = {
  // MOCK_MODE = true: a página inteira funciona com dados falsos, sem precisar de
  // Supabase nem Efí configurados ainda. Serve pra demonstrar o fluxo pro cliente e
  // testar a interface enquanto a conta Efí não é aprovada. Trocar pra false só quando
  // SUPABASE_URL/ANON_KEY e MAKE_WEBHOOK_RESERVAR abaixo forem os valores reais.
  MOCK_MODE: false,
  SUPABASE_URL: 'https://zlmghzvgbwuhopdpgkta.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsbWdoenZnYnd1aG9wZHBna3RhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMTIzNjQsImV4cCI6MjEwMzg4ODM2NH0.7ymbr3hNJz4xsa3DpDDDIOJONZdzWsS2mvhrnL_jSxI',
  MAKE_WEBHOOK_RESERVAR: 'https://hook.us2.make.com/71f9xx5l66bsfdz0h6iadd1i2mz0fj7c',
  TOTAL_NUMEROS: 1000,
  POLL_INTERVALO_MS: 4000,
  // Alternativa manual caso o webhook automático falhe ou demore — chave PIX real do
  // cliente (Nubank), a mesma cadastrada na conta Efí como chave de recebimento.
  PIX_CHAVE_FALLBACK: '55997331063',
  WHATSAPP_FALLBACK: '5555997331063',
  // Chave pública VAPID (não é secreta -- a privada fica só no servidor de push).
  // Usada pelo painel administrativo pra ativar notificações push.
  PUSH_VAPID_PUBLIC_KEY: 'BCYQWxu0Zw-QJlc-CsKpv_PQcf7VlMLi9QYqsI39NY-9RCF4yQTMGIF1DVa-PNVujrVnGAhrw2S9BGKXYc-T0Dg',
};
