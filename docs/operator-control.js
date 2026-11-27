(() => {
  const form = document.getElementById("operator-form");
  const target = document.getElementById("operator-target");
  const token = document.getElementById("operator-token");
  const check = document.getElementById("operator-check");
  const apply = document.getElementById("operator-apply");
  const badge = document.getElementById("operator-badge");
  const note = document.getElementById("operator-status");
  const labels = { n8n: "n8n", node: "Node.js · código de GitHub", none: "Sin operador activo", unknown: "Estado pendiente de confirmar" };

  async function askOperator(method) {
    if (!token.reportValidity()) return;
    check.disabled = apply.disabled = true;
    note.textContent = method === "POST" ? "Aplicando el cambio y comprobando quién atiende el bot…" : "Consultando el operador…";
    try {
      const response = await fetch("./api/operator", {
        method, redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(70000),
        headers: { Authorization: "Bearer " + token.value.trim(), "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ target: target.value }) } : {}),
      });
      const payload = await response.json();
      if (!response.ok) {
        badge.textContent = payload.error === "OPERATOR_UNCONFIGURED" ? "SIN CONFIGURAR" : "POR COMPROBAR";
        const message = typeof payload.message === "string" ? payload.message : "El servidor no pudo verificar el operador.";
        note.textContent = message;
        return;
      }
      const active = Object.hasOwn(labels, payload.active) ? payload.active : "unknown";
      badge.textContent = labels[active];
      if (active === "n8n" || active === "node") target.value = active;
      note.textContent = payload.switching ? "Hay un cambio en curso. Vuelve a consultar el estado."
        : active === "none" || active === "unknown" ? labels[active] + "."
        : "Operador confirmado para Telegram.";
    } catch {
      badge.textContent = "POR COMPROBAR";
      note.textContent = "No se pudo consultar el estado. Usa Consultar operador antes de volver a aplicar un cambio.";
    } finally {
      check.disabled = apply.disabled = false;
    }
  }

  check.addEventListener("click", () => askOperator("GET"));
  form.addEventListener("submit", event => { event.preventDefault(); askOperator("POST"); });
})();
