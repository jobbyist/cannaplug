export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      articles: {
        Row: {
          body_md: string;
          category: string;
          cover_credit_name: string | null;
          cover_credit_url: string | null;
          cover_image_url: string | null;
          created_at: string;
          excerpt: string;
          id: string;
          published_at: string;
          reading_minutes: number;
          slug: string;
          sources: Json;
          title: string;
        };
        Insert: {
          body_md: string;
          category?: string;
          cover_credit_name?: string | null;
          cover_credit_url?: string | null;
          cover_image_url?: string | null;
          created_at?: string;
          excerpt: string;
          id?: string;
          published_at?: string;
          reading_minutes?: number;
          slug: string;
          sources?: Json;
          title: string;
        };
        Update: {
          body_md?: string;
          category?: string;
          cover_credit_name?: string | null;
          cover_credit_url?: string | null;
          cover_image_url?: string | null;
          created_at?: string;
          excerpt?: string;
          id?: string;
          published_at?: string;
          reading_minutes?: number;
          slug?: string;
          sources?: Json;
          title?: string;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          action: string;
          actor_user_id: string | null;
          created_at: string;
          entity_id: string | null;
          entity_type: string;
          id: number;
          metadata: Json;
          target_user_id: string | null;
        };
        Insert: {
          action: string;
          actor_user_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type: string;
          id?: never;
          metadata?: Json;
          target_user_id?: string | null;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string;
          id?: never;
          metadata?: Json;
          target_user_id?: string | null;
        };
        Relationships: [];
      };
      chat_rate_limits: {
        Row: {
          request_count: number;
          session_id: string;
          total_count: number;
          updated_at: string;
          window_start: string;
        };
        Insert: {
          request_count?: number;
          session_id: string;
          total_count?: number;
          updated_at?: string;
          window_start?: string;
        };
        Update: {
          request_count?: number;
          session_id?: string;
          total_count?: number;
          updated_at?: string;
          window_start?: string;
        };
        Relationships: [];
      };
      newsroom_job_state: {
        Row: {
          id: string;
          last_error: string | null;
          last_run_at: string | null;
          lease_until: string | null;
          paused_at: string | null;
          paused_reason: string | null;
        };
        Insert: {
          id: string;
          last_error?: string | null;
          last_run_at?: string | null;
          lease_until?: string | null;
          paused_at?: string | null;
          paused_reason?: string | null;
        };
        Update: {
          id?: string;
          last_error?: string | null;
          last_run_at?: string | null;
          lease_until?: string | null;
          paused_at?: string | null;
          paused_reason?: string | null;
        };
        Relationships: [];
      };
      inventory_batches: {
        Row: {
          qty_on_hand: number;
          qty_held: number;
          batch_code: string;
          created_at: string;
          created_by: string | null;
          expires_at: string | null;
          id: string;
          notes: string | null;
          product_id: string;
          received_at: string;
          unit_cost_rand: number | null;
        };
        Insert: {
          qty_on_hand?: number;
          qty_held?: number;
          batch_code: string;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          notes?: string | null;
          product_id: string;
          received_at?: string;
          unit_cost_rand?: number | null;
        };
        Update: {
          qty_on_hand?: number;
          qty_held?: number;
          batch_code?: string;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          notes?: string | null;
          product_id?: string;
          received_at?: string;
          unit_cost_rand?: number | null;
        };
        Relationships: [];
      };
      inventory_ledger: {
        Row: {
          movement_type: string;
          actor_user_id: string | null;
          batch_id: string;
          created_at: string;
          id: string;
          product_id: string;
          quantity_delta: number;
          reason: string;
          reference_id: string | null;
          reference_type: string | null;
        };
        Insert: {
          movement_type: string;
          actor_user_id?: string | null;
          batch_id: string;
          created_at?: string;
          id?: string;
          product_id: string;
          quantity_delta: number;
          reason: string;
          reference_id?: string | null;
          reference_type?: string | null;
        };
        Update: {
          movement_type?: string;
          actor_user_id?: string | null;
          batch_id?: string;
          created_at?: string;
          id?: string;
          product_id?: string;
          quantity_delta?: number;
          reason?: string;
          reference_id?: string | null;
          reference_type?: string | null;
        };
        Relationships: [];
      };
      order_status_history: {
        Row: {
          actor_user_id: string | null;
          created_at: string;
          from_status: string | null;
          id: string;
          note: string | null;
          order_id: string;
          to_status: string;
        };
        Insert: {
          actor_user_id?: string | null;
          created_at?: string;
          from_status?: string | null;
          id?: string;
          note?: string | null;
          order_id: string;
          to_status: string;
        };
        Update: {
          actor_user_id?: string | null;
          created_at?: string;
          from_status?: string | null;
          id?: string;
          note?: string | null;
          order_id?: string;
          to_status?: string;
        };
        Relationships: [];
      };
      product_price_history: {
        Row: {
          changed_by: string | null;
          created_at: string;
          effective_from: string;
          effective_to: string | null;
          id: string;
          price_rand: number;
          product_id: string;
        };
        Insert: {
          changed_by?: string | null;
          created_at?: string;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          price_rand: number;
          product_id: string;
        };
        Update: {
          changed_by?: string | null;
          created_at?: string;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          price_rand?: number;
          product_id?: string;
        };
        Relationships: [];
      };
      // <m3-tables>
      cash_drawers: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          location: string | null;
          name: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          location?: string | null;
          name: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          location?: string | null;
          name?: string;
        };
        Relationships: [];
      };
      loyalty_ledger: {
        Row: {
          created_at: string;
          id: string;
          points: number;
          sale_id: string | null;
          source_id: string;
          source_type: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          points: number;
          sale_id?: string | null;
          source_id: string;
          source_type: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          points?: number;
          sale_id?: string | null;
          source_id?: string;
          source_type?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      operation_idempotency: {
        Row: {
          created_at: string;
          key: string;
          request_hash: string;
          response: Json | null;
          scope: string;
        };
        Insert: {
          created_at?: string;
          key: string;
          request_hash: string;
          response?: Json | null;
          scope: string;
        };
        Update: {
          created_at?: string;
          key?: string;
          request_hash?: string;
          response?: Json | null;
          scope?: string;
        };
        Relationships: [];
      };
      payment_events: {
        Row: {
          amount: number | null;
          created_at: string;
          id: string;
          order_id: string | null;
          outcome: string;
          provider: string;
          provider_event_id: string;
        };
        Insert: {
          amount?: number | null;
          created_at?: string;
          id?: string;
          order_id?: string | null;
          outcome: string;
          provider: string;
          provider_event_id: string;
        };
        Update: {
          amount?: number | null;
          created_at?: string;
          id?: string;
          order_id?: string | null;
          outcome?: string;
          provider?: string;
          provider_event_id?: string;
        };
        Relationships: [];
      };
      pos_refund_items: {
        Row: {
          id: string;
          quantity: number;
          refund_id: string;
          sale_item_id: string;
        };
        Insert: {
          id?: string;
          quantity: number;
          refund_id: string;
          sale_item_id: string;
        };
        Update: {
          id?: string;
          quantity?: number;
          refund_id?: string;
          sale_item_id?: string;
        };
        Relationships: [];
      };
      pos_refund_payouts: {
        Row: {
          amount: number;
          id: string;
          method: string;
          reference: string | null;
          refund_id: string;
        };
        Insert: {
          amount: number;
          id?: string;
          method: string;
          reference?: string | null;
          refund_id: string;
        };
        Update: {
          amount?: number;
          id?: string;
          method?: string;
          reference?: string | null;
          refund_id?: string;
        };
        Relationships: [];
      };
      pos_refunds: {
        Row: {
          actor_user_id: string;
          amount: number;
          created_at: string;
          id: string;
          idempotency_key: string;
          reason: string;
          restocked: boolean;
          sale_id: string;
          session_id: string;
        };
        Insert: {
          actor_user_id: string;
          amount: number;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          reason: string;
          restocked: boolean;
          sale_id: string;
          session_id: string;
        };
        Update: {
          actor_user_id?: string;
          amount?: number;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          reason?: string;
          restocked?: boolean;
          sale_id?: string;
          session_id?: string;
        };
        Relationships: [];
      };
      pos_sale_items: {
        Row: {
          id: string;
          line_total: number;
          product_id: string;
          product_name: string;
          quantity: number;
          refunded_quantity: number;
          sale_id: string;
          unit_price_rand: number;
        };
        Insert: {
          id?: string;
          line_total: number;
          product_id: string;
          product_name: string;
          quantity: number;
          refunded_quantity?: number;
          sale_id: string;
          unit_price_rand: number;
        };
        Update: {
          id?: string;
          line_total?: number;
          product_id?: string;
          product_name?: string;
          quantity?: number;
          refunded_quantity?: number;
          sale_id?: string;
          unit_price_rand?: number;
        };
        Relationships: [];
      };
      pos_sales: {
        Row: {
          cashier_id: string;
          created_at: string;
          customer_id: string | null;
          id: string;
          idempotency_key: string;
          receipt_number: string;
          session_id: string;
          status: string;
          subtotal: number;
          total: number;
          void_reason: string | null;
          voided_at: string | null;
          voided_by: string | null;
        };
        Insert: {
          cashier_id: string;
          created_at?: string;
          customer_id?: string | null;
          id?: string;
          idempotency_key: string;
          receipt_number: string;
          session_id: string;
          status?: string;
          subtotal: number;
          total: number;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
        };
        Update: {
          cashier_id?: string;
          created_at?: string;
          customer_id?: string | null;
          id?: string;
          idempotency_key?: string;
          receipt_number?: string;
          session_id?: string;
          status?: string;
          subtotal?: number;
          total?: number;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
        };
        Relationships: [];
      };
      pos_sessions: {
        Row: {
          actual_cash: number | null;
          approval_note: string | null;
          approval_status: string;
          approved_at: string | null;
          approved_by: string | null;
          close_note: string | null;
          closed_at: string | null;
          closed_by: string | null;
          drawer_id: string;
          expected_cash: number | null;
          id: string;
          opened_at: string;
          opened_by: string;
          opening_float: number;
          sales_count: number | null;
          status: string;
          tender_totals: Json | null;
          variance: number | null;
        };
        Insert: {
          actual_cash?: number | null;
          approval_note?: string | null;
          approval_status?: string;
          approved_at?: string | null;
          approved_by?: string | null;
          close_note?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
          drawer_id: string;
          expected_cash?: number | null;
          id?: string;
          opened_at?: string;
          opened_by: string;
          opening_float: number;
          sales_count?: number | null;
          status?: string;
          tender_totals?: Json | null;
          variance?: number | null;
        };
        Update: {
          actual_cash?: number | null;
          approval_note?: string | null;
          approval_status?: string;
          approved_at?: string | null;
          approved_by?: string | null;
          close_note?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
          drawer_id?: string;
          expected_cash?: number | null;
          id?: string;
          opened_at?: string;
          opened_by?: string;
          opening_float?: number;
          sales_count?: number | null;
          status?: string;
          tender_totals?: Json | null;
          variance?: number | null;
        };
        Relationships: [];
      };
      pos_tenders: {
        Row: {
          amount: number;
          created_at: string;
          id: string;
          method: string;
          reference: string | null;
          sale_id: string;
        };
        Insert: {
          amount: number;
          created_at?: string;
          id?: string;
          method: string;
          reference?: string | null;
          sale_id: string;
        };
        Update: {
          amount?: number;
          created_at?: string;
          id?: string;
          method?: string;
          reference?: string | null;
          sale_id?: string;
        };
        Relationships: [];
      };
      stock_reservations: {
        Row: {
          batch_id: string;
          created_at: string;
          expires_at: string;
          id: string;
          order_id: string;
          order_item_id: string;
          product_id: string;
          quantity: number;
          resolved_at: string | null;
          status: string;
        };
        Insert: {
          batch_id: string;
          created_at?: string;
          expires_at: string;
          id?: string;
          order_id: string;
          order_item_id: string;
          product_id: string;
          quantity: number;
          resolved_at?: string | null;
          status?: string;
        };
        Update: {
          batch_id?: string;
          created_at?: string;
          expires_at?: string;
          id?: string;
          order_id?: string;
          order_item_id?: string;
          product_id?: string;
          quantity?: number;
          resolved_at?: string | null;
          status?: string;
        };
        Relationships: [];
      };
      // </m3-tables>
      order_items: {
        Row: {
          id: string;
          order_id: string;
          product_id: string | null;
          product_name: string;
          quantity: number;
          unit_price_rand: number;
        };
        Insert: {
          id?: string;
          order_id: string;
          product_id?: string | null;
          product_name: string;
          quantity: number;
          unit_price_rand: number;
        };
        Update: {
          id?: string;
          order_id?: string;
          product_id?: string | null;
          product_name?: string;
          quantity?: number;
          unit_price_rand?: number;
        };
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "order_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
        ];
      };
      orders: {
        Row: {
          contact_name: string | null;
          contact_phone: string | null;
          created_at: string;
          id: string;
          notes: string | null;
          order_number: string;
          status: string;
          total_rand: number;
          user_id: string;
        };
        Insert: {
          contact_name?: string | null;
          contact_phone?: string | null;
          created_at?: string;
          id?: string;
          notes?: string | null;
          order_number?: string;
          status?: string;
          total_rand?: number;
          user_id: string;
        };
        Update: {
          contact_name?: string | null;
          contact_phone?: string | null;
          created_at?: string;
          id?: string;
          notes?: string | null;
          order_number?: string;
          status?: string;
          total_rand?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      products: {
        Row: {
          badge: string | null;
          category: string;
          created_at: string;
          description: string | null;
          id: string;
          is_active: boolean;
          name: string;
          price_rand: number;
          slug: string;
          sort_order: number;
          strain_type: string | null;
          subcategory: string | null;
          unit: string | null;
        };
        Insert: {
          badge?: string | null;
          category: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          name: string;
          price_rand: number;
          slug: string;
          sort_order?: number;
          strain_type?: string | null;
          subcategory?: string | null;
          unit?: string | null;
        };
        Update: {
          badge?: string | null;
          category?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          name?: string;
          price_rand?: number;
          slug?: string;
          sort_order?: number;
          strain_type?: string | null;
          subcategory?: string | null;
          unit?: string | null;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          address: string | null;
          created_at: string;
          date_of_birth: string | null;
          full_name: string | null;
          id: string;
          phone: string | null;
          updated_at: string;
        };
        Insert: {
          address?: string | null;
          created_at?: string;
          date_of_birth?: string | null;
          full_name?: string | null;
          id: string;
          phone?: string | null;
          updated_at?: string;
        };
        Update: {
          address?: string | null;
          created_at?: string;
          date_of_birth?: string | null;
          full_name?: string | null;
          id?: string;
          phone?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      // <m3-views>
      inventory_availability: {
        Row: {
          available: number | null;
          batches: number | null;
          consumed: number | null;
          expired: number | null;
          held: number | null;
          on_hand: number | null;
          product_id: string | null;
        };
        Relationships: [];
      };
      stock_movements: {
        Row: {
          actor_user_id: string | null;
          batch_id: string | null;
          created_at: string | null;
          id: string | null;
          movement_type: string | null;
          product_id: string | null;
          quantity_delta: number | null;
          reason: string | null;
          reference_id: string | null;
          reference_type: string | null;
        };
        Relationships: [];
      };
      // </m3-views>
    };
    Functions: {
      // <m3-functions>
      accrue_missing_pos_loyalty: { Args: { p_limit?: number }; Returns: number };
      accrue_pos_loyalty: { Args: { p_sale_id: string }; Returns: Json };
      adjust_stock: {
        Args: {
          p_actor: string;
          p_batch_id: string;
          p_delta: number;
          p_idempotency_key: string;
          p_reason: string;
        };
        Returns: Json;
      };
      confirm_order_payment: {
        Args: {
          p_amount: number;
          p_order_id: string;
          p_provider: string;
          p_provider_event_id: string;
        };
        Returns: Json;
      };
      create_online_order: {
        Args: {
          p_contact_name: string | null;
          p_contact_phone: string | null;
          p_hold_minutes?: number;
          p_idempotency_key: string;
          p_items: Json;
          p_notes: string | null;
          p_user_id: string;
        };
        Returns: Json;
      };
      pos_close_session: {
        Args: {
          p_actor: string;
          p_actual_cash: number;
          p_idempotency_key: string;
          p_note: string | null;
          p_session_id: string;
        };
        Returns: Json;
      };
      pos_complete_sale: {
        Args: {
          p_actor: string;
          p_customer_id: string | null;
          p_idempotency_key: string;
          p_items: Json;
          p_session_id: string;
          p_tenders: Json;
        };
        Returns: Json;
      };
      pos_open_session: {
        Args: {
          p_actor: string;
          p_drawer_id: string;
          p_idempotency_key: string;
          p_opening_float: number;
        };
        Returns: Json;
      };
      pos_refund_sale: {
        Args: {
          p_actor: string;
          p_idempotency_key: string;
          p_items: Json;
          p_payouts: Json;
          p_reason: string;
          p_restock: boolean;
          p_sale_id: string;
          p_session_id: string;
        };
        Returns: Json;
      };
      pos_review_session: {
        Args: { p_actor: string; p_approve: boolean; p_note: string; p_session_id: string };
        Returns: Json;
      };
      pos_upsert_drawer: {
        Args: {
          p_actor: string;
          p_drawer_id: string | null;
          p_is_active: boolean;
          p_location: string | null;
          p_name: string;
        };
        Returns: Json;
      };
      pos_void_sale: {
        Args: { p_actor: string; p_idempotency_key: string; p_reason: string; p_sale_id: string };
        Returns: Json;
      };
      receive_stock: {
        Args: {
          p_actor: string;
          p_batch_code: string;
          p_expires_at: string | null;
          p_idempotency_key: string;
          p_notes: string | null;
          p_product_id: string;
          p_quantity: number;
          p_unit_cost: number | null;
        };
        Returns: Json;
      };
      purge_old_idempotency_keys: { Args: { p_retain?: string }; Returns: number };
      release_expired_reservations: { Args: never; Returns: number };
      reserve_order_stock: { Args: { p_order_id: string; p_ttl_minutes?: number }; Returns: Json };
      // </m3-functions>
      current_user_role: {
        Args: never;
        Returns: Database["public"]["Enums"]["app_role"];
      };
      has_at_least_role: {
        Args: { _required: Database["public"]["Enums"]["app_role"] };
        Returns: boolean;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      is_staff: { Args: never; Returns: boolean };
      order_status_transition_allowed: {
        Args: { p_from: string; p_to: string };
        Returns: boolean;
      };
      transition_order_status: {
        Args: {
          p_actor_user_id: string;
          p_note?: string;
          p_order_id: string;
          p_to_status: string;
        };
        Returns: Database["public"]["Tables"]["orders"]["Row"];
      };
      role_level: {
        Args: { _role: Database["public"]["Enums"]["app_role"] };
        Returns: number;
      };
    };
    Enums: {
      app_role: "admin" | "user" | "customer" | "budtender" | "manager";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user", "customer", "budtender", "manager"],
    },
  },
} as const;
