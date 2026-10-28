export const shareLinks = (url: string, title: string) => {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  return [
    { id: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${t}%20${u}` },
    { id: "x", label: "X", href: `https://twitter.com/intent/tweet?text=${t}&url=${u}` },
    {
      id: "facebook",
      label: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    },
    { id: "email", label: "Email", href: `mailto:?subject=${t}&body=${u}` },
  ];
};
