/**
 * Sends the member to the provider's hosted page. PayFast expects its signed fields as a form POST to
 * /eng/process, so a PayFast URL (signed fields in its query string) is turned into an auto-submitted form;
 * every other provider is a plain navigation.
 */
export const isPayFastUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)payfast\.co\.za$/.test(u.hostname);
  } catch {
    return false;
  }
};

export function payFastForm(url: string, doc: Document): HTMLFormElement {
  const u = new URL(url);
  const form = doc.createElement("form");
  form.method = "POST";
  form.action = `${u.origin}${u.pathname}`;
  form.style.display = "none";
  for (const [name, value] of u.searchParams.entries()) {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  return form;
}

export function goToCheckout(url: string): void {
  if (isPayFastUrl(url)) {
    const form = payFastForm(url, document);
    document.body.appendChild(form);
    form.submit();
    return;
  }
  window.location.assign(url);
}
