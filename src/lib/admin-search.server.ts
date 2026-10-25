import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type SearchOrder = {
  id: string;
  order_number: string;
  contact_name: string | null;
  status: string;
  total_rand: number;
  delivery_method: string | null;
  created_at: string;
};
export type SearchCustomer = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  order_count: number;
};
export type SearchProduct = {
  id: string;
  name: string;
  category: string;
  sku: string | null;
  brand: string | null;
  price_rand: number;
  is_active: boolean;
  available: number;
};
export type SearchSale = {
  id: string;
  receipt_number: string;
  status: string;
  total: number;
  created_at: string;
};
export type AdminSearchResults = {
  orders: SearchOrder[];
  customers: SearchCustomer[];
  products: SearchProduct[];
  sales: SearchSale[];
};

/** One indexed query across orders, customers, products and till sales; the database checks the staff role. */
export async function adminSearch(userId: string, query: string): Promise<AdminSearchResults> {
  const { data, error } = await supabaseAdmin.rpc("admin_search", {
    p_actor: userId,
    p_query: query,
    p_limit: 6,
  });
  if (error) throw error;
  return data as unknown as AdminSearchResults;
}
