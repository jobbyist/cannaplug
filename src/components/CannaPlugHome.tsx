import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, useScroll } from "framer-motion";
import {
  ArrowRight, BadgeCheck, CalendarDays, Check, ChevronDown, ChevronRight, CircleUserRound,
  Clock3, Facebook, Headphones, Instagram, Leaf, Mail, MapPin, Menu, MessageCircle,
  Newspaper, PackageCheck, Phone, Play, Search, ShieldCheck, ShoppingBag,
  Store, TicketPercent, Truck, UsersRound, X, Youtube,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import heroImage from "@/assets/cannaplug-hero.jpg";
import categoryImage from "@/assets/cannaplug-categories.jpg";
import productImage from "@/assets/cannaplug-products.jpg";
import editorialImage from "@/assets/cannaplug-editorial.jpg";
import storeAsset from "@/assets/cannaplug-storefront.jpg.asset.json";

const stories = [
  { label: "My Story", title: "CannaPlug", copy: "Good plants. Great people.", icon: Leaf, image: heroImage, cta: "Discover our story" },
  { label: "Menu", title: "Explore the CannaPlug Menu.", copy: "A considered selection for every kind of experience.", icon: Menu, image: categoryImage, cta: "View the menu" },
  { label: "Products", title: "Curated cannabis. Premium quality.", copy: "Products selected with care, knowledge and high standards.", icon: ShoppingBag, image: productImage, cta: "Shop products" },
  { label: "Deals", title: "Plug into something special.", copy: "Limited drops and thoughtful rewards for our community.", icon: TicketPercent, image: productImage, cta: "See the latest" },
  { label: "Events", title: "Good vibes. Great people.", copy: "Meet the people shaping cannabis culture in South Africa.", icon: CalendarDays, image: editorialImage, cta: "See events" },
  { label: "Newsroom", title: "Cannabis culture, decoded.", copy: "Useful, informed stories without the noise.", icon: Newspaper, image: editorialImage, cta: "Read the journal" },
  { label: "Locations", title: "Come visit the Plug.", copy: "Shop 002, One On Mutual, Pretoria Central.", icon: MapPin, image: storeAsset.url, cta: "Get directions" },
  { label: "Contact", title: "Come say hello.", copy: "Real advice from knowledgeable people who care.", icon: Mail, image: storeAsset.url, cta: "Contact us" },
];

const categories = [
  ["Flower", "Premium Strains", "category-pos-1"], ["Edibles", "Gourmet Infusions", "category-pos-2"],
  ["Vapes", "Discreet & Smooth", "category-pos-3"], ["Concentrates", "Pure Potency", "category-pos-4"],
  ["Accessories", "Tools & Essentials", "category-pos-5"],
];

const products = [
  ["Gelato 33", "Premium Flower", "R350", "Premium", "product-pos-1"],
  ["Blue Mix", "Premium Flower", "R420", "Best seller", "product-pos-2"],
  ["Mixed Flavour Gummies", "Edibles · 10 pack", "R300", "Popular", "product-pos-3"],
  ["Raw Distillate Cart", "Vape · 1g", "R420", "Lab tested", "product-pos-4"],
  ["CannaPlug Grinder", "Accessories", "R250", "New", "product-pos-5"],
];

const news = [
  ["Cannabis education", "Understanding Cannabis Strains: Indica vs Sativa vs Hybrid", "The language is familiar. The science is more nuanced. Here’s a clear place to begin.", "08 Sep 2026", "editorial-pos-1"],
  ["Industry", "The Rise of Premium Cannabis in South Africa", "A closer look at the people, craft and standards shaping a more considered market.", "02 Sep 2026", "editorial-pos-2"],
  ["Wellness", "Cannabis & Wellness: A More Informed Conversation", "Thoughtful guidance for making responsible, personal and well-informed choices.", "28 Aug 2026", "editorial-pos-3"],
];

const events = [
  ["19", "SEP", "CannaPlug Culture Session", "Pretoria Central", "An intimate evening of education, music and conversation.", "event-one"],
  ["04", "OCT", "Wellness & Cannabis Workshop", "Johannesburg", "Practical, informed guidance with local wellness practitioners.", "event-two"],
  ["08", "NOV", "CannaPlug Community Mixer", "Cape Town", "Good people, fresh perspectives and a distinctly local energy.", "event-three"],
];

function Logo({ inverse = false }: { inverse?: boolean }) {
  return <a href="/#top" aria-label="CannaPlug home" className={inverse ? "logo inverse" : "logo"}><span className="logo-mark"><Leaf size={21} fill="currentColor" /></span><span><b>CANNA</b><small>PLUG</small></span></a>;
}

function SectionHeading({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: string }) {
  return <div className="section-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>{action && <a href="/#shop" className="text-link">{action}<ArrowRight size={15} /></a>}</div>;
}

function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return <motion.div className={className} initial={reduce ? false : { opacity: 0, y: 26 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-80px" }} transition={{ duration: .65, ease: [0.22, 1, 0.36, 1] }}>{children}</motion.div>;
}

function StoryNavigation() {
  const [active, setActive] = useState<number | null>(null);
  const story = active === null ? null : stories[active];
  useEffect(() => {
    if (!story) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && setActive(null);
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", closeOnEscape); };
  }, [story]);
  return <>
    <div className="stories-wrap" aria-label="CannaPlug stories"><div className="stories">
      {stories.map((item, i) => <button key={item.label} className="story" onClick={() => setActive(i)}><span className="story-ring"><item.icon size={22} /></span><span>{item.label}</span></button>)}
      <a className="story-social" href="https://instagram.com/cannaplug_012" target="_blank" rel="noreferrer">Join our community <Instagram size={16} /></a>
    </div></div>
    <AnimatePresence>{story && <motion.div className="story-modal" role="dialog" aria-modal="true" aria-label={story.title} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setActive(null)}>
      <motion.article initial={{ opacity: 0, scale: .97, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: 8 }} transition={{ duration: .28, ease: [0.22, 1, 0.36, 1] }} onClick={e => e.stopPropagation()}>
        <div className="story-progress"><span /></div><IconButton aria-label="Close story" className="story-close" onClick={() => setActive(null)}><X size={20} /></IconButton>
        <img src={story.image} alt="" /><div className="story-shade" /><div className="story-copy"><p>{story.label}</p><h2>{story.title}</h2><span>{story.copy}</span><Button onClick={() => setActive(null)}>{story.cta}<ArrowRight size={15} /></Button></div>
      </motion.article>
    </motion.div>}</AnimatePresence>
  </>;
}

export function Header() {
  const { scrollY } = useScroll(); const [compact, setCompact] = useState(false); const [open, setOpen] = useState(false); const [search, setSearch] = useState(false);
  const { count } = useCart(); const { user } = useAuth();
  useEffect(() => scrollY.on("change", value => setCompact(value > 80)), [scrollY]);
  const links: [string, string][] = [["Home", "/"], ["Shop", "/shop"], ["Menu", "/#categories"], ["Events", "/#events"], ["Newsroom", "/newsroom"], ["About", "/#experience"], ["Contact", "/#contact"]];
  const primaryLinks = [[Store, "Home", "/"], [ShoppingBag, "Shop products", "/shop"], [Menu, "Explore menu", "/#categories"], [CalendarDays, "Events", "/#events"]] as const;
  const exploreLinks = [[Newspaper, "Newsroom", "/newsroom"], [Leaf, "Our story", "/#experience"], [TicketPercent, "Plug Back", "/#plug-back"], [MapPin, "Visit Pretoria", "/#contact"]] as const;
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  return <header className={compact ? "header compact" : "header"}><div className="header-inner"><Logo /><nav>{links.map(([label, href]) => <a key={href} href={href}>{label}</a>)}</nav><div className="header-actions">
    <IconButton aria-label="Search" aria-expanded={search} onClick={() => setSearch(!search)}><Search size={20} /></IconButton>
    <a className="header-icon-link desktop-icon" aria-label={user ? "Your account" : "Sign in"} href="/account"><CircleUserRound size={20} /></a>
    <a className="header-icon-link cart-link" aria-label={`Shopping bag, ${count} item${count === 1 ? "" : "s"}`} href="/checkout"><ShoppingBag size={20} />{count > 0 && <b>{count}</b>}</a>
    <IconButton aria-label="Open menu" aria-expanded={open} className="mobile-menu" onClick={() => setOpen(true)}><Menu size={21} /></IconButton>
  </div></div>{search && <motion.div className="search-panel" initial={{ height: 0 }} animate={{ height: "auto" }}><Search size={18} /><input autoFocus aria-label="Search products" placeholder="Search products, stories and events…" /></motion.div>}
  <AnimatePresence>{open && <motion.div className="mobile-nav-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)}><motion.aside className="mobile-nav" role="dialog" aria-modal="true" aria-label="Main menu" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: .32, ease: [0.22, 1, 0.36, 1] }} onClick={event => event.stopPropagation()}>
    <div className="mobile-nav-head"><Logo/><IconButton aria-label="Close menu" onClick={() => setOpen(false)}><X size={22}/></IconButton></div>
    <div className="mobile-nav-body"><nav className="mobile-nav-primary">{primaryLinks.map(([Icon,label,href],index) => <a className={index === 0 ? "active" : ""} key={href} href={href} onClick={() => setOpen(false)}><Icon size={20}/><span>{label}</span>{index === 1 && <small>Curated</small>}</a>)}</nav>
    <div className="mobile-explore"><div className="mobile-explore-title"><span><Leaf size={20}/>Explore</span><ChevronDown size={18}/></div><div className="mobile-explore-grid">{exploreLinks.map(([Icon,label,href]) => <a key={href} href={href} onClick={() => setOpen(false)}><Icon size={25}/><span>{label}</span></a>)}</div></div>
    <nav className="mobile-nav-secondary"><a href="/#contact" onClick={() => setOpen(false)}><MessageCircle size={19}/><span>Contact the team</span><ChevronRight size={17}/></a><a href="/account" onClick={() => setOpen(false)}><CircleUserRound size={19}/><span>{user ? "Your account" : "Sign in / Join"}</span><ChevronRight size={17}/></a></nav></div>
    <div className="mobile-nav-foot"><span>18+ · Consume responsibly</span><a href="https://instagram.com/cannaplug_012" target="_blank" rel="noreferrer">Instagram <Instagram size={15}/></a></div>
  </motion.aside></motion.div>}</AnimatePresence></header>;
}


function Hero() {
  return <section className="hero" id="top"><img className="hero-image" src={heroImage} alt="Premium CannaPlug cannabis flower and apothecary jar" width={1920} height={1080}/><div className="hero-wash"/><motion.div className="hero-content" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .8 }}><p className="eyebrow">Premium cannabis dispensary</p><h1>QUALITY CANNABIS.<br/><em>REAL PEOPLE.</em></h1><p className="hero-lede">Premium products. Expert guidance.<br/>A better cannabis experience.</p><div className="hero-buttons"><Button onClick={() => document.querySelector("#shop")?.scrollIntoView({ behavior: "smooth" })}>Shop now <ArrowRight size={16}/></Button><Button variant="outline" onClick={() => document.querySelector("#categories")?.scrollIntoView({ behavior: "smooth" })}>Explore the menu <ArrowRight size={16}/></Button></div></motion.div>
    <div className="trust-row">{[[Leaf,"Premium quality"],[BadgeCheck,"Lab tested"],[Truck,"Discreet delivery"],[Headphones,"Expert support"]].map(([I,label]) => { const C = I as typeof Leaf; return <div key={label as string}><C size={22}/><span>{label as string}</span></div>})}</div>
  </section>;
}

function Categories() { return <section className="page-section" id="categories"><Reveal><SectionHeading title="SHOP BY CATEGORY" action="View all"/><div className="category-grid">{categories.map(([name, desc, pos]) => <a href="/#shop" className="category-card" key={name}><div className="category-image"><img src={categoryImage} alt={`${name} category`} className={pos} loading="lazy" width={1920} height={768}/></div><div><h3>{name}</h3><p>{desc}</p></div><span><ArrowRight size={16}/></span></a>)}</div></Reveal></section> }

function Products() {
  const [added, setAdded] = useState<string | null>(null);
  return <section className="page-section product-section" id="shop"><Reveal><SectionHeading eyebrow="Curated selection" title="FEATURED PRODUCTS" action="Shop all"/><div className="product-grid">{products.map(([name, cat, price, badge, pos]) => <article className="product-card" key={name}><div className="product-visual"><span className="badge">{badge}</span><img src={productImage} alt={name} className={pos} loading="lazy" width={1920} height={768}/></div><div className="product-info"><p>{cat}</p><h3>{name}</h3><div><b>{price}</b><Button aria-label={`Add ${name} to cart`} onClick={() => { setAdded(name); window.setTimeout(() => setAdded(null), 1600); }}>{added === name ? <><Check size={15}/> Added</> : <>Add to cart <ShoppingBag size={15}/></>}</Button></div></div></article>)}</div></Reveal></section>
}

function CampaignBanner() { return <section className="campaign-shell" id="plug-back"><Reveal><div className="campaign"><div className="campaign-title"><p className="eyebrow">Pre-roll tube take-back · Now on</p><h2>PLUG<br/>BACK.</h2><p>Recycle & get rewarded.</p></div><div className="campaign-copy"><div className="bring-get"><b>BRING</b><span>10 empty <strong>CannaPlug</strong><br/>pre-roll tubes</span><b>GET</b><span>1 complimentary<br/><strong>Greenhouse</strong> pre-roll</span></div><h3>10 TUBES <i>=</i> 1 FREE</h3><blockquote>Less plastic on the streets.<br/>More smoke in your pocket.</blockquote><small>In-store only · Original CannaPlug tubes · While stocks last</small></div></div></Reveal></section> }

function ExperienceSection() { const points = [[MessageCircle,"Expert guidance","Real advice. No judgement."],[ShieldCheck,"Quality assured","A carefully selected range."],[UsersRound,"Community","Culture, education and connection."],[PackageCheck,"Discretion","Professional at every touchpoint."]]; return <section className="experience" id="experience"><Reveal className="experience-inner"><div className="experience-copy"><p className="eyebrow">Good plants. Great people.</p><h2>THE CANNA PLUG<br/><em>EXPERIENCE</em></h2><p>We're more than a dispensary — we're a community.</p><p>CannaPlug is built on quality, education and a deep respect for the plant. Whether you're exploring cannabis for the first time or you're already a connoisseur, we're here to elevate the experience.</p></div><div className="principles">{points.map(([I,title,copy]) => { const C=I as typeof Leaf; return <div key={title as string}><C size={27}/><h3>{title as string}</h3><p>{copy as string}</p></div>})}</div></Reveal></section> }

function Newsroom() { return <section className="page-section" id="newsroom"><Reveal><SectionHeading eyebrow="The CannaPlug Journal" title="NEWSROOM" action="All stories"/><div className="news-grid">{news.map(([cat,title,excerpt,date,pos], i) => <article className={i===0 ? "news-card news-lead" : "news-card"} key={title}><div className="news-image"><img src={editorialImage} className={pos} alt="" loading="lazy" width={1920} height={800}/></div><div className="news-content"><p className="eyebrow">{cat} · {date}</p><h3>{title}</h3><p>{excerpt}</p><a href="/#newsroom">Read more <ArrowRight size={15}/></a></div></article>)}</div></Reveal></section> }

function Events() { return <section className="events" id="events"><Reveal><SectionHeading eyebrow="Good vibes & great people" title="UPCOMING EVENTS" action="View calendar"/><div className="event-grid">{events.map(([day,month,title,location,copy,style]) => <article className={`event-card ${style}`} key={title}><div className="event-date"><strong>{day}</strong><span>{month}</span></div><div className="event-copy"><p><MapPin size={14}/>{location}</p><h3>{title}</h3><span>{copy}</span><a href="/#events">RSVP / View event <ArrowRight size={15}/></a></div></article>)}</div></Reveal></section> }

function ContactSection() {
  const [sent,setSent] = useState(false); const submit=(e:FormEvent)=>{e.preventDefault();setSent(true)};
  return <section className="contact" id="contact"><Reveal className="contact-grid"><div className="contact-info"><p className="eyebrow">Contact us</p><h2>WE'RE HERE<br/><em>TO HELP.</em></h2><p>Questions, recommendations or a first visit? Speak to our team.</p><ul><li><Phone size={18}/><a href="tel:+27101234567">+27 10 123 4567</a></li><li><Mail size={18}/><a href="mailto:hello@cannaplug.co.za">hello@cannaplug.co.za</a></li><li><MapPin size={18}/><span>Shop 002, One On Mutual, Pretoria Central</span></li><li><Clock3 size={18}/><span>Mon–Fri 09:00–19:00 · Sat 09:00–20:00 · Sun 09:00–15:00</span></li></ul><a className="direction-link" href="https://maps.google.com/?q=One+On+Mutual+Pretoria" target="_blank" rel="noreferrer">Get directions <ArrowRight size={16}/></a></div><div className="store-panel"><img src={storeAsset.url} alt="Inside the CannaPlug Pretoria dispensary" loading="lazy"/><span><Play size={18} fill="currentColor"/> Visit CannaPlug Pretoria</span></div><form onSubmit={submit}><div><label>Name<input required placeholder="Your name"/></label><label>Email<input required type="email" placeholder="you@example.com"/></label></div><label>Subject<input required placeholder="How can we help?"/></label><label>Message<textarea required rows={5} placeholder="Write your message…"/></label><Button type="submit">{sent ? <><Check size={16}/> Message ready</> : <>Send message <ArrowRight size={16}/></>}</Button>{sent && <small>Thanks — this visual prototype does not submit messages yet.</small>}</form></Reveal></section>
}

function Footer() { return <footer><div className="footer-main"><div className="footer-brand"><Logo inverse/><h2>GOOD PLANTS.<br/>GREAT PEOPLE.</h2><p>Premium cannabis, curated with care in Pretoria.</p></div><div><h3>Explore</h3>{["Shop","Menu","Events","Newsroom","About","Contact"].map(x=><a href={`/#${x.toLowerCase()}`} key={x}>{x}</a>)}</div><div><h3>Information</h3><a href="/#contact">FAQ</a><a href="/#contact">Privacy</a><a href="/#contact">Terms</a><a href="/#contact">Responsible consumption</a></div><div className="newsletter"><h3>Stay connected</h3><p>Get the latest stories, events and CannaPlug news.</p><form onSubmit={e=>e.preventDefault()}><input aria-label="Email address" type="email" placeholder="Email address"/><Button type="submit">Join <ArrowRight size={15}/></Button></form><div className="socials"><a aria-label="Instagram" href="https://instagram.com/cannaplug_012" target="_blank" rel="noreferrer"><Instagram/></a><a aria-label="TikTok" href="https://www.tiktok.com/@cannaplug_012" target="_blank" rel="noreferrer"><Youtube/></a><a aria-label="X" href="https://x.com/cannaplug_012" target="_blank" rel="noreferrer"><X/></a><a aria-label="Facebook" href="https://facebook.com/cannaplug" target="_blank" rel="noreferrer"><Facebook/></a></div></div></div><div className="footer-bottom"><span>18+ · Consume responsibly</span><span>Licensed Medical Cannabis Dispensary · SAHPRA Section 21 Authorised · Registration No. 2026/047873/07</span><span>© 2026 CannaPlug™</span></div></footer> }

function FloatingBottomNav() { return <motion.nav className="floating-nav" aria-label="Quick navigation" initial={{ y: 80, opacity:0 }} animate={{ y:0, opacity:1 }} transition={{ delay:.8, type:"spring" }}><a href="/#top"><Store/><span>Home</span></a><a href="/#shop"><ShoppingBag/><span>Shop</span></a><a href="/#top" className="float-leaf" aria-label="CannaPlug home"><Leaf fill="currentColor"/></a><a href="/#events"><CalendarDays/><span>Events</span></a><a href="/#newsroom" className="desktop-float"><Newspaper/><span>Newsroom</span></a><a href="/#contact" className="mobile-float"><CircleUserRound/><span>Account</span></a></motion.nav> }

export function CannaPlugHome() { return <div className="site"><StoryNavigation/><Header/><main><Hero/><Categories/><Products/><CampaignBanner/><ExperienceSection/><Newsroom/><Events/><ContactSection/></main><Footer/><FloatingBottomNav/></div> }