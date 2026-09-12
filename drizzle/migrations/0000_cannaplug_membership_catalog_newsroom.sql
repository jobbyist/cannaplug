-- PROFILES
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  full_name text,
  phone text,
  date_of_birth date,
  address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, phone, date_of_birth, address)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'phone',
    NULLIF(NEW.raw_user_meta_data ->> 'date_of_birth','')::date,
    NEW.raw_user_meta_data ->> 'address'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- PRODUCTS
CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  subcategory text,
  description text,
  price_rand numeric(10,2) NOT NULL,
  unit text,
  strain_type text,
  badge text,
  sort_order int NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.products TO anon, authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "products public read" ON public.products FOR SELECT TO anon, authenticated USING (is_active);

-- ORDERS
CREATE SEQUENCE public.order_number_seq START 1042;
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  order_number text NOT NULL UNIQUE DEFAULT ('CP-' || to_char(now(),'YYMM') || '-' || lpad(nextval('public.order_number_seq')::text, 4, '0')),
  status text NOT NULL DEFAULT 'awaiting_payment',
  total_rand numeric(10,2) NOT NULL DEFAULT 0,
  contact_name text,
  contact_phone text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.orders TO authenticated;
GRANT USAGE ON SEQUENCE public.order_number_seq TO authenticated, service_role;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own orders select" ON public.orders FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own orders insert" ON public.orders FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id),
  product_name text NOT NULL,
  unit_price_rand numeric(10,2) NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0)
);
GRANT SELECT, INSERT ON public.order_items TO authenticated;
GRANT ALL ON public.order_items TO service_role;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own order items select" ON public.order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));
CREATE POLICY "own order items insert" ON public.order_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));

-- ARTICLES
CREATE TABLE public.articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  body_md text NOT NULL,
  category text NOT NULL DEFAULT 'Cannabis culture',
  reading_minutes int NOT NULL DEFAULT 7,
  cover_image_url text,
  cover_credit_name text,
  cover_credit_url text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.articles TO anon, authenticated;
GRANT ALL ON public.articles TO service_role;
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "articles public read" ON public.articles FOR SELECT TO anon, authenticated USING (true);

-- NEWSROOM JOB STATE (single-flight lock + circuit breaker)
CREATE TABLE public.newsroom_job_state (
  id text PRIMARY KEY,
  lease_until timestamptz,
  paused_reason text,
  paused_at timestamptz,
  last_run_at timestamptz,
  last_error text
);
GRANT ALL ON public.newsroom_job_state TO service_role;
ALTER TABLE public.newsroom_job_state ENABLE ROW LEVEL SECURITY;
INSERT INTO public.newsroom_job_state (id) VALUES ('daily-article');

-- PRODUCT SEED (from CannaPlug in-store menus)
INSERT INTO public.products (slug, name, category, subcategory, description, price_rand, unit, strain_type, badge, sort_order) VALUES
('blue-gelato-greenhouse','Blue Gelato','Flower','Greenhouse','Sweet, dessert-leaning greenhouse flower with a balanced, easy lift.',50,'per gram','Hybrid','Popular',10),
('sour-og-greenhouse','Sour OG','Flower','Greenhouse','Sharp citrus nose with a bright, energising finish.',50,'per gram','Sativa',NULL,11),
('purple-fritter-greenhouse','Purple Fritter','Flower','Greenhouse','Soft, pastry-sweet greenhouse bud with a mellow body.',50,'per gram','Hybrid',NULL,12),
('orange-cookies-greenhouse','Orange Cookies','Flower','Greenhouse','Citrus-forward and calming, a comfortable evening flower.',50,'per gram','Indica',NULL,13),
('velvet-moon-greendoor','Velvet Moon','Flower','Greendoor','Smooth, deep and relaxing with a rich earthy finish.',70,'per gram','Indica',NULL,20),
('white-widow-greendoor','White Widow','Flower','Greendoor','A true classic — resinous, balanced and reliably smooth.',70,'per gram','Hybrid','Classic',21),
('mandarin-cookies-greendoor','Mandarin Cookies','Flower','Greendoor','Bright citrus and sweet dough on a lifted, social high.',70,'per gram','Sativa',NULL,22),
('triple-cheese-indoor','Triple Cheese','Flower','Premium indoor','Bold, funky and full-bodied premium indoor flower.',100,'per gram','Indica','Premium',30),
('kings-juice-indoor','Kings Juice','Flower','Premium indoor','Juicy, layered terps with a long, even finish.',100,'per gram','Hybrid','Premium',31),
('gorilla-zkittlez-indoor','Gorilla Zkittlez','Flower','Premium indoor','Heavy resin, candy sweetness and a deeply relaxing body.',100,'per gram','Indica','Best seller',32),
('lemon-sativa-outdoor','Lemon Sativa','Flower','Outdoor','Fresh lemon lift — an easy, affordable daytime option.',120,'5g','Sativa','Value',40),
('grapefruit-outdoor','Grapefruit','Flower','Outdoor','Tangy and uplifting outdoor flower in a 5g bag.',120,'5g','Sativa','Value',41),
('greenhouse-preroll','Greenhouse Pre-roll','Pre-rolls','Greenhouse','Ready-to-go greenhouse joint. Rotating strain selection.',50,'each','Hybrid',NULL,50),
('greenhouse-preroll-5','Greenhouse Pre-roll · 5 pack','Pre-rolls','Greenhouse','Five greenhouse pre-rolls at a better price.',200,'5 pack','Hybrid','Bundle',51),
('premium-indoor-preroll','Premium Indoor Pre-roll','Pre-rolls','Premium indoor','Premium indoor flower, expertly rolled.',100,'each','Hybrid','Premium',52),
('top-shelf-preroll','Top Shelf Pre-roll','Pre-rolls','Top shelf','Our best flower in a single, generous joint.',120,'each','Hybrid','Top shelf',53),
('top-shelf-preroll-3','Top Shelf Pre-roll · 3 pack','Pre-rolls','Top shelf','Three top-shelf pre-rolls for the whole session.',300,'3 pack','Hybrid','Bundle',54),
('moonsticks','Moonsticks','Speciality','Smoke station','Infused, high-potency stick for experienced smokers.',140,'each',NULL,'High potency',60),
('indoor-cannagars','Indoor Cannagars','Speciality','Smoke station','Slow-burning premium indoor cannagar for sharing.',250,'each',NULL,'Premium',61),
('dab-kief-2in1','Dab & Kief 2-in-1','Concentrates','Speciality','Dab and kief combination — rich, potent and smooth.',150,'each',NULL,NULL,62),
('honeycomb-dab','Honeycomb Dab','Concentrates','Per gram','Golden honeycomb dab, sold per gram.',250,'per gram',NULL,'Lab tested',63),
('peanut-brittle-100','Peanut Brittle 100mg','Edibles','Gummies & sweets','Crunchy peanut brittle, evenly dosed at 100mg.',70,'each',NULL,NULL,70),
('wonder-gummies','Wonder Gummies · 5 x 50mg','Edibles','Gummies & sweets','Five 50mg gummies — a consistent, easy starting point.',250,'5 pack',NULL,'Popular',71),
('sour-worms-50','Sour Worms 50mg','Edibles','Gummies & sweets','Classic sour worms with a gentle, even lift.',70,'each',NULL,NULL,72),
('fruit-burst-100','Fruit Burst 100mg','Edibles','Gummies & sweets','Bright fruit flavour at a stronger 100mg dose.',100,'each',NULL,NULL,73),
('fudge-100','Fudge 100mg','Edibles','Fudge & toffee','Rich chocolate fudge, dosed at 100mg.',100,'each',NULL,NULL,74),
('zen-toffees','Zen Toffees · 10 x 50mg','Edibles','Fudge & toffee','Ten 50mg toffees to pace through the week.',250,'10 pack',NULL,'Bundle',75),
('brownies-100','Brownies 100mg','Edibles','Baked','Soft, properly baked 100mg brownie.',100,'each',NULL,NULL,76),
('lollipop-200','Lollipop 200mg','Edibles','Gummies & sweets','A long, slow 200mg lollipop.',30,'each',NULL,NULL,77),
('mini-ice-cream-cones','Stuffed Mini Ice-Cream Cones 50mg','Edibles','Baked','Playful stuffed mini cones at a friendly 50mg.',100,'each',NULL,'New',78),
('sodaze-spicy-pineapple','Sodaze Spicy Pineapple 30mg','Drinks','THC drinks','Spicy pineapple infused soda, 30mg.',50,'can',NULL,NULL,80),
('sodaze-cream-soda','Sodaze Cream Soda 30mg','Drinks','THC drinks','Nostalgic cream soda with a 30mg lift.',50,'can',NULL,NULL,81),
('lucky-club-mango','Lucky Club Mango Fruit Juice 50mg','Drinks','THC drinks','Mango juice infused at 50mg — smooth and easy.',70,'bottle',NULL,'Popular',82),
('lucky-club-blueberry-vanilla','Lucky Club Blueberry Vanilla Iced Tea 50mg','Drinks','THC drinks','Blueberry vanilla iced tea, infused at 50mg.',70,'bottle',NULL,NULL,83),
('reusable-cannabis-cartridge','Reusable Cannabis Cartridge','Vapes','Carts','Refillable cannabis cartridge — discreet and smooth.',420,'each',NULL,'Lab tested',90),
('disposable-cannabis-cartridge','Disposable Cannabis Cartridge','Vapes','Carts','Grab-and-go disposable cart.',420,'each',NULL,NULL,91),
('cbd-distillate-refill-cart','CBD Distillate Refill Cart','Vapes','CBD','CBD distillate refill for your existing device.',420,'each',NULL,NULL,92),
('cbd-oil-1000','CBD Oil 1000mg','CBD','Wellness','Full-strength 1000mg CBD oil for daily wellness.',250,'bottle',NULL,NULL,100),
('cbd-oil-500','CBD Oil 500mg','CBD','Wellness','Everyday 500mg CBD oil.',150,'bottle',NULL,NULL,101),
('honeyworx-750','750ml Honeyworx','CBD','Wellness','Honeyworx infused honey, 750ml.',500,'bottle',NULL,'Premium',102),
('cookies-metallic-crusher','Cookies Metallic Crusher','Accessories','Crushers','Solid metal crusher built to last.',120,'each',NULL,NULL,110),
('raw-tray-large','Raw Tray · Large','Accessories','Trays','Large Raw rolling tray for a proper set-up.',250,'each',NULL,NULL,111),
('raw-tray-small','Raw Tray · Small','Accessories','Trays','Compact Raw rolling tray.',150,'each',NULL,NULL,112),
('bic-maxi-lighter','Bic Maxi Lighter','Accessories','Lighters','Dependable Bic Maxi.',20,'each',NULL,NULL,113),
('ashtray-jumbo','Ashtray Jumbo','Accessories','Essentials','Large ashtray for the session table.',40,'each',NULL,NULL,114),
('joint-holder-plain','Joint Holder · Plain','Accessories','Essentials','Simple, sturdy joint holder.',120,'each',NULL,NULL,115),
('hubbly-flavour-gum-mint','Hubbly Flavour · Gum & Mint','Accessories','Hubbly','Cool gum and mint hubbly flavour.',40,'each',NULL,NULL,116),
('blue-mix-coconut-coal','Blue Mix Coconut Coal','Accessories','Hubbly','Clean-burning coconut coal.',40,'pack',NULL,NULL,117);