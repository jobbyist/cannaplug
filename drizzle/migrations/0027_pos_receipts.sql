-- Prompt 3b (23 Oct 2026): POS receipts — printable (80 mm, 58 mm, A4) and emailed as a branded PDF.
-- * receipt_settings: one row of business details shown on every receipt, manager-edited through the server.
--   VAT is off until the business registers; when switched on, receipts show the VAT included in the total.
-- * pos_receipt_meta: cash tendered for a sale (so the receipt can show change); written once per sale.
-- * pos_receipt_sends: every emailed receipt (rate-limited per sale). All three are service-role only.

CREATE TABLE IF NOT EXISTS public.receipt_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  trading_name text NOT NULL CHECK (length(trading_name) BETWEEN 1 AND 80),
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 120),
  registration_number text CHECK (registration_number IS NULL OR length(registration_number) <= 40),
  licence_lines text[] NOT NULL DEFAULT '{}' CHECK (cardinality(licence_lines) <= 4),
  address text NOT NULL CHECK (length(address) BETWEEN 1 AND 200),
  phone text CHECK (phone IS NULL OR length(phone) <= 40),
  email text CHECK (email IS NULL OR length(email) <= 120),
  vat_registered boolean NOT NULL DEFAULT false,
  vat_number text CHECK (vat_number IS NULL OR vat_number ~ '^4[0-9]{9}$'),
  vat_rate numeric(4,2) NOT NULL DEFAULT 15 CHECK (vat_rate > 0 AND vat_rate < 100),
  footer_message text CHECK (footer_message IS NULL OR length(footer_message) <= 200),
  returns_policy text CHECK (returns_policy IS NULL OR length(returns_policy) <= 300),
  default_paper text NOT NULL DEFAULT '80mm' CHECK (default_paper IN ('80mm', '58mm', 'a4')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT receipt_settings_vat_chk CHECK (NOT vat_registered OR vat_number IS NOT NULL)
);
ALTER TABLE public.receipt_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receipt_settings FROM anon, authenticated;
GRANT ALL ON public.receipt_settings TO service_role;

INSERT INTO public.receipt_settings
  (id, trading_name, legal_name, registration_number, licence_lines, address, phone, email, footer_message, returns_policy)
VALUES
  (true, 'CannaPlug', 'CANNAPLUG PTY LTD', '2026/047873/07',
   ARRAY['Licensed medical cannabis dispensary', 'SAHPRA Section 21 authorised'],
   'Shop 002, One On Mutual, Pretoria Central', '+27 68 291 2107', 'info@cannaplug012.co.za',
   'Thank you for shopping with CannaPlug.', 'Keep this receipt for returns. See cannaplug012.co.za/refund-policy.')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.pos_receipt_meta (
  sale_id uuid PRIMARY KEY REFERENCES public.pos_sales(id) ON DELETE RESTRICT,
  cash_received numeric(10,2) CHECK (cash_received IS NULL OR cash_received > 0),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pos_receipt_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_receipt_meta FROM anon, authenticated;
GRANT ALL ON public.pos_receipt_meta TO service_role;

CREATE TABLE IF NOT EXISTS public.pos_receipt_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.pos_sales(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  provider_message_id text,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_receipt_sends_sale_idx ON public.pos_receipt_sends (sale_id, created_at);
ALTER TABLE public.pos_receipt_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_receipt_sends FROM anon, authenticated;
GRANT ALL ON public.pos_receipt_sends TO service_role;
