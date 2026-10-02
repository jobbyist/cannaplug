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
      // <m4-tables>
      addresses: {
        Row: {
          city: string | null;
          country: string;
          created_at: string;
          delivery_notes: string | null;
          id: string;
          is_default: boolean;
          label: string;
          line1: string;
          line2: string | null;
          phone: string | null;
          postal_code: string | null;
          province: string | null;
          recipient_name: string | null;
          suburb: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          city?: string | null;
          country?: string;
          created_at?: string;
          delivery_notes?: string | null;
          id?: string;
          is_default?: boolean;
          label?: string;
          line1: string;
          line2?: string | null;
          phone?: string | null;
          postal_code?: string | null;
          province?: string | null;
          recipient_name?: string | null;
          suburb?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          city?: string | null;
          country?: string;
          created_at?: string;
          delivery_notes?: string | null;
          id?: string;
          is_default?: boolean;
          label?: string;
          line1?: string;
          line2?: string | null;
          phone?: string | null;
          postal_code?: string | null;
          province?: string | null;
          recipient_name?: string | null;
          suburb?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      back_in_stock_subscriptions: {
        Row: {
          created_at: string;
          id: string;
          notified_at: string | null;
          product_id: string;
          status: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          notified_at?: string | null;
          product_id: string;
          status?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          notified_at?: string | null;
          product_id?: string;
          status?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      customer_verification: {
        Row: {
          attempt_count: number;
          created_at: string;
          declared_dob: string | null;
          document_path: string | null;
          document_type: string | null;
          metadata: Json;
          method: string | null;
          provider_reference: string | null;
          rejection_code: string | null;
          rejection_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: string;
          submitted_at: string | null;
          updated_at: string;
          user_id: string;
          verified_at: string | null;
          verified_by: string | null;
        };
        Insert: {
          attempt_count?: number;
          created_at?: string;
          declared_dob?: string | null;
          document_path?: string | null;
          document_type?: string | null;
          metadata?: Json;
          method?: string | null;
          provider_reference?: string | null;
          rejection_code?: string | null;
          rejection_note?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: string;
          submitted_at?: string | null;
          updated_at?: string;
          user_id: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Update: {
          attempt_count?: number;
          created_at?: string;
          declared_dob?: string | null;
          document_path?: string | null;
          document_type?: string | null;
          metadata?: Json;
          method?: string | null;
          provider_reference?: string | null;
          rejection_code?: string | null;
          rejection_note?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: string;
          submitted_at?: string | null;
          updated_at?: string;
          user_id?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Relationships: [];
      };
      delivery_options: {
        Row: {
          code: string;
          description: string | null;
          fee_rand: number;
          is_active: boolean;
          label: string;
          sort_order: number;
        };
        Insert: {
          code: string;
          description?: string | null;
          fee_rand: number;
          is_active?: boolean;
          label: string;
          sort_order?: number;
        };
        Update: {
          code?: string;
          description?: string | null;
          fee_rand?: number;
          is_active?: boolean;
          label?: string;
          sort_order?: number;
        };
        Relationships: [];
      };
      loyalty_accounts: {
        Row: {
          created_at: string;
          lifetime_points: number;
          points_balance: number;
          tier_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          lifetime_points?: number;
          points_balance?: number;
          tier_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          lifetime_points?: number;
          points_balance?: number;
          tier_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      loyalty_rules: {
        Row: {
          code: string;
          description: string;
          updated_at: string;
          value: number;
        };
        Insert: {
          code: string;
          description: string;
          updated_at?: string;
          value: number;
        };
        Update: {
          code?: string;
          description?: string;
          updated_at?: string;
          value?: number;
        };
        Relationships: [];
      };
      loyalty_tiers: {
        Row: {
          code: string;
          id: string;
          is_active: boolean;
          min_lifetime_points: number;
          name: string;
          perks: string[];
          sort_order: number;
        };
        Insert: {
          code: string;
          id?: string;
          is_active?: boolean;
          min_lifetime_points: number;
          name: string;
          perks?: string[];
          sort_order?: number;
        };
        Update: {
          code?: string;
          id?: string;
          is_active?: boolean;
          min_lifetime_points?: number;
          name?: string;
          perks?: string[];
          sort_order?: number;
        };
        Relationships: [];
      };
      loyalty_transactions: {
        Row: {
          balance_after: number;
          created_at: string;
          id: string;
          order_id: string | null;
          points: number;
          pos_sale_id: string | null;
          source_id: string;
          source_type: string;
          txn_type: string;
          user_id: string;
        };
        Insert: {
          balance_after: number;
          created_at?: string;
          id?: string;
          order_id?: string | null;
          points: number;
          pos_sale_id?: string | null;
          source_id: string;
          source_type: string;
          txn_type: string;
          user_id: string;
        };
        Update: {
          balance_after?: number;
          created_at?: string;
          id?: string;
          order_id?: string | null;
          points?: number;
          pos_sale_id?: string | null;
          source_id?: string;
          source_type?: string;
          txn_type?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      wishlist_items: {
        Row: {
          created_at: string;
          product_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          product_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          product_id?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      // </m4-tables>
      // <clinical-tables>
      clinical_retention_policy: {
        Row: {
          basis: string;
          confirmed_at: string | null;
          confirmed_by: string | null;
          proposed_min_years: number;
          purge_enabled: boolean;
          record_class: string;
          status: string;
        };
        Insert: {
          basis: string;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          proposed_min_years: number;
          purge_enabled?: boolean;
          record_class: string;
          status?: string;
        };
        Update: {
          basis?: string;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          proposed_min_years?: number;
          purge_enabled?: boolean;
          record_class?: string;
          status?: string;
        };
        Relationships: [];
      };
      doctor_patient_assignments: {
        Row: {
          assigned_by: string | null;
          created_at: string;
          doctor_id: string;
          ended_at: string | null;
          ended_by: string | null;
          id: string;
          member_id: string;
          status: string;
        };
        Insert: {
          assigned_by?: string | null;
          created_at?: string;
          doctor_id: string;
          ended_at?: string | null;
          ended_by?: string | null;
          id?: string;
          member_id: string;
          status?: string;
        };
        Update: {
          assigned_by?: string | null;
          created_at?: string;
          doctor_id?: string;
          ended_at?: string | null;
          ended_by?: string | null;
          id?: string;
          member_id?: string;
          status?: string;
        };
        Relationships: [];
      };
      doctor_profiles: {
        Row: {
          created_at: string;
          first_name: string;
          hpcsa_number: string | null;
          id: string;
          is_active: boolean;
          last_name: string;
          practice_address: string | null;
          practice_email: string | null;
          practice_name: string | null;
          practice_number: string | null;
          practice_phone: string | null;
          prescribing_authorised: boolean;
          qualification: string | null;
          signature_provider: string | null;
          signature_provider_ref: string | null;
          signature_status: string;
          speciality: string | null;
          title: string;
          updated_at: string;
          user_id: string;
          verification_note: string | null;
          verification_status: string;
          verified_at: string | null;
          verified_by: string | null;
        };
        Insert: {
          created_at?: string;
          first_name: string;
          hpcsa_number?: string | null;
          id?: string;
          is_active?: boolean;
          last_name: string;
          practice_address?: string | null;
          practice_email?: string | null;
          practice_name?: string | null;
          practice_number?: string | null;
          practice_phone?: string | null;
          prescribing_authorised?: boolean;
          qualification?: string | null;
          signature_provider?: string | null;
          signature_provider_ref?: string | null;
          signature_status?: string;
          speciality?: string | null;
          title?: string;
          updated_at?: string;
          user_id: string;
          verification_note?: string | null;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Update: {
          created_at?: string;
          first_name?: string;
          hpcsa_number?: string | null;
          id?: string;
          is_active?: boolean;
          last_name?: string;
          practice_address?: string | null;
          practice_email?: string | null;
          practice_name?: string | null;
          practice_number?: string | null;
          practice_phone?: string | null;
          prescribing_authorised?: boolean;
          qualification?: string | null;
          signature_provider?: string | null;
          signature_provider_ref?: string | null;
          signature_status?: string;
          speciality?: string | null;
          title?: string;
          updated_at?: string;
          user_id?: string;
          verification_note?: string | null;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Relationships: [];
      };
      document_counters: {
        Row: {
          document_type: string;
          last_value: number;
          year: number;
        };
        Insert: {
          document_type: string;
          last_value?: number;
          year: number;
        };
        Update: {
          document_type?: string;
          last_value?: number;
          year?: number;
        };
        Relationships: [];
      };
      document_events: {
        Row: {
          actor_role: string;
          actor_user_id: string | null;
          created_at: string;
          document_id: string;
          event_type: string;
          id: number;
          ip_address: string | null;
          metadata: Json;
          user_agent: string | null;
        };
        Insert: {
          actor_role: string;
          actor_user_id?: string | null;
          created_at?: string;
          document_id: string;
          event_type: string;
          id?: number;
          ip_address?: string | null;
          metadata?: Json;
          user_agent?: string | null;
        };
        Update: {
          actor_role?: string;
          actor_user_id?: string | null;
          created_at?: string;
          document_id?: string;
          event_type?: string;
          id?: number;
          ip_address?: string | null;
          metadata?: Json;
          user_agent?: string | null;
        };
        Relationships: [];
      };
      document_requests: {
        Row: {
          admin_reference: string | null;
          assigned_at: string | null;
          assigned_by: string | null;
          created_at: string;
          created_by: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_reason: string | null;
          doctor_id: string | null;
          document_id: string | null;
          document_type: string;
          fulfilled_at: string | null;
          id: string;
          member_id: string;
          member_note: string | null;
          source: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          admin_reference?: string | null;
          assigned_at?: string | null;
          assigned_by?: string | null;
          created_at?: string;
          created_by: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_reason?: string | null;
          doctor_id?: string | null;
          document_id?: string | null;
          document_type: string;
          fulfilled_at?: string | null;
          id?: string;
          member_id: string;
          member_note?: string | null;
          source?: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          admin_reference?: string | null;
          assigned_at?: string | null;
          assigned_by?: string | null;
          created_at?: string;
          created_by?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_reason?: string | null;
          doctor_id?: string | null;
          document_id?: string | null;
          document_type?: string;
          fulfilled_at?: string | null;
          id?: string;
          member_id?: string;
          member_note?: string | null;
          source?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      document_signature_policy: {
        Row: {
          confirmation_note: string | null;
          confirmed_at: string | null;
          confirmed_by: string | null;
          document_type: string;
          required_assurance: string;
          updated_at: string;
        };
        Insert: {
          confirmation_note?: string | null;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          document_type: string;
          required_assurance: string;
          updated_at?: string;
        };
        Update: {
          confirmation_note?: string | null;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          document_type?: string;
          required_assurance?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      document_signatures: {
        Row: {
          assurance_level: string;
          certificate_issuer: string | null;
          certificate_serial: string | null;
          certificate_subject: string | null;
          created_at: string;
          doctor_id: string;
          document_hash_after_signature: string | null;
          document_hash_before_signature: string;
          document_id: string;
          failure_code: string | null;
          id: string;
          provider_request_id: string | null;
          signature_metadata: Json;
          signature_method: string;
          signature_provider: string;
          signature_reference: string | null;
          signed_at: string | null;
          status: string;
        };
        Insert: {
          assurance_level: string;
          certificate_issuer?: string | null;
          certificate_serial?: string | null;
          certificate_subject?: string | null;
          created_at?: string;
          doctor_id: string;
          document_hash_after_signature?: string | null;
          document_hash_before_signature: string;
          document_id: string;
          failure_code?: string | null;
          id?: string;
          provider_request_id?: string | null;
          signature_metadata?: Json;
          signature_method: string;
          signature_provider: string;
          signature_reference?: string | null;
          signed_at?: string | null;
          status?: string;
        };
        Update: {
          assurance_level?: string;
          certificate_issuer?: string | null;
          certificate_serial?: string | null;
          certificate_subject?: string | null;
          created_at?: string;
          doctor_id?: string;
          document_hash_after_signature?: string | null;
          document_hash_before_signature?: string;
          document_id?: string;
          failure_code?: string | null;
          id?: string;
          provider_request_id?: string | null;
          signature_metadata?: Json;
          signature_method?: string;
          signature_provider?: string;
          signature_reference?: string | null;
          signed_at?: string | null;
          status?: string;
        };
        Relationships: [];
      };
      document_templates: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          change_note: string | null;
          created_at: string;
          created_by: string | null;
          document_type: string;
          effective_from: string | null;
          effective_until: string | null;
          id: string;
          name: string;
          review_note: string | null;
          status: string;
          template_content: string;
          template_schema: Json;
          updated_at: string;
          version: number;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          change_note?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_type: string;
          effective_from?: string | null;
          effective_until?: string | null;
          id?: string;
          name: string;
          review_note?: string | null;
          status?: string;
          template_content: string;
          template_schema: Json;
          updated_at?: string;
          version: number;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          change_note?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_type?: string;
          effective_from?: string | null;
          effective_until?: string | null;
          id?: string;
          name?: string;
          review_note?: string | null;
          status?: string;
          template_content?: string;
          template_schema?: Json;
          updated_at?: string;
          version?: number;
        };
        Relationships: [];
      };
      document_verifications: {
        Row: {
          created_at: string;
          document_hash: string | null;
          document_id: string;
          id: string;
          requester_hash: string | null;
          verification_status: string;
          verification_token: string;
          verified_at: string;
        };
        Insert: {
          created_at?: string;
          document_hash?: string | null;
          document_id: string;
          id?: string;
          requester_hash?: string | null;
          verification_status: string;
          verification_token: string;
          verified_at?: string;
        };
        Update: {
          created_at?: string;
          document_hash?: string | null;
          document_id?: string;
          id?: string;
          requester_hash?: string | null;
          verification_status?: string;
          verification_token?: string;
          verified_at?: string;
        };
        Relationships: [];
      };
      document_verify_attempts: {
        Row: {
          attempts: number;
          bucket: string;
          window_start: string;
        };
        Insert: {
          attempts?: number;
          bucket: string;
          window_start: string;
        };
        Update: {
          attempts?: number;
          bucket?: string;
          window_start?: string;
        };
        Relationships: [];
      };
      medical_documents: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          created_at: string;
          created_by: string;
          doctor_id: string;
          document_hash: string | null;
          document_id: string;
          document_type: string;
          document_version: number;
          expires_at: string | null;
          id: string;
          issued_at: string | null;
          member_id: string;
          pdf_storage_path: string | null;
          rendered_content: string | null;
          review_note: string | null;
          review_started_at: string | null;
          revocation_reason: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          source_data_snapshot: Json;
          status: string;
          supersedes_document_id: string | null;
          template_id: string;
          template_version: number;
          updated_at: string;
          verification_token: string;
          voided_at: string | null;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          created_by: string;
          doctor_id: string;
          document_hash?: string | null;
          document_id: string;
          document_type: string;
          document_version?: number;
          expires_at?: string | null;
          id?: string;
          issued_at?: string | null;
          member_id: string;
          pdf_storage_path?: string | null;
          rendered_content?: string | null;
          review_note?: string | null;
          review_started_at?: string | null;
          revocation_reason?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          source_data_snapshot?: Json;
          status?: string;
          supersedes_document_id?: string | null;
          template_id: string;
          template_version: number;
          updated_at?: string;
          verification_token: string;
          voided_at?: string | null;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          created_by?: string;
          doctor_id?: string;
          document_hash?: string | null;
          document_id?: string;
          document_type?: string;
          document_version?: number;
          expires_at?: string | null;
          id?: string;
          issued_at?: string | null;
          member_id?: string;
          pdf_storage_path?: string | null;
          rendered_content?: string | null;
          review_note?: string | null;
          review_started_at?: string | null;
          revocation_reason?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          source_data_snapshot?: Json;
          status?: string;
          supersedes_document_id?: string | null;
          template_id?: string;
          template_version?: number;
          updated_at?: string;
          verification_token?: string;
          voided_at?: string | null;
        };
        Relationships: [];
      };
      prescription_orders: {
        Row: {
          created_at: string;
          directions: string | null;
          document_id: string;
          dosage_form: string | null;
          duration: string | null;
          frequency: string | null;
          generic_name: string | null;
          id: string;
          indication: string | null;
          issue_date: string | null;
          medicine_name: string | null;
          member_id: string;
          prescriber_id: string;
          quantity_numeric: number | null;
          quantity_words: string | null;
          repeats: number | null;
          route: string | null;
          special_instructions: string | null;
          status: string;
          strength: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          directions?: string | null;
          document_id: string;
          dosage_form?: string | null;
          duration?: string | null;
          frequency?: string | null;
          generic_name?: string | null;
          id?: string;
          indication?: string | null;
          issue_date?: string | null;
          medicine_name?: string | null;
          member_id: string;
          prescriber_id: string;
          quantity_numeric?: number | null;
          quantity_words?: string | null;
          repeats?: number | null;
          route?: string | null;
          special_instructions?: string | null;
          status?: string;
          strength?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          directions?: string | null;
          document_id?: string;
          dosage_form?: string | null;
          duration?: string | null;
          frequency?: string | null;
          generic_name?: string | null;
          id?: string;
          indication?: string | null;
          issue_date?: string | null;
          medicine_name?: string | null;
          member_id?: string;
          prescriber_id?: string;
          quantity_numeric?: number | null;
          quantity_words?: string | null;
          repeats?: number | null;
          route?: string | null;
          special_instructions?: string | null;
          status?: string;
          strength?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      signature_providers: {
        Row: {
          assurance_level: string;
          confirmation_note: string | null;
          confirmed_at: string | null;
          confirmed_by: string | null;
          display_name: string;
          enabled: boolean;
          provider: string;
          signature_method: string;
          updated_at: string;
        };
        Insert: {
          assurance_level?: string;
          confirmation_note?: string | null;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          display_name: string;
          enabled?: boolean;
          provider: string;
          signature_method: string;
          updated_at?: string;
        };
        Update: {
          assurance_level?: string;
          confirmation_note?: string | null;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          display_name?: string;
          enabled?: boolean;
          provider?: string;
          signature_method?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      // </clinical-tables>
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
          payment_method: string | null;
          delivery_method: string | null;
          delivery_fee_rand: number;
          delivery_address: Json | null;
          loyalty_points_redeemed: number;
          loyalty_discount_rand: number;
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
          payment_method?: string | null;
          delivery_method?: string | null;
          delivery_fee_rand?: number;
          delivery_address?: Json | null;
          loyalty_points_redeemed?: number;
          loyalty_discount_rand?: number;
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
          payment_method?: string | null;
          delivery_method?: string | null;
          delivery_fee_rand?: number;
          delivery_address?: Json | null;
          loyalty_points_redeemed?: number;
          loyalty_discount_rand?: number;
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
      // <clinical-functions>
      clinical_document_access: {
        Args: {
          p_actor: string | null;
          p_doc: string | null;
          p_ip?: string | null;
          p_kind: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_admin_events: {
        Args: { p_actor: string | null; p_limit?: number };
        Returns: Json;
      };
      clinical_document_admin_list: {
        Args: { p_actor: string | null; p_limit?: number; p_status?: string | null };
        Returns: Json;
      };
      clinical_document_begin_signing: {
        Args: {
          p_actor: string | null;
          p_doc: string | null;
          p_expected_hash: string | null;
          p_ip?: string | null;
          p_provider: string | null;
          p_provider_request_id: string | null;
          p_ua?: string | null;
          p_unsigned_pdf_hash: string | null;
        };
        Returns: Json;
      };
      clinical_document_complete_signing: {
        Args: {
          p_actor: string | null;
          p_doc: string | null;
          p_ip?: string | null;
          p_sig: Json;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_create: {
        Args: {
          p_actor: string | null;
          p_clinical: Json;
          p_expires_at: string | null;
          p_idempotency_key: string | null;
          p_ip?: string | null;
          p_member_id: string | null;
          p_prescription: Json;
          p_supersedes?: string | null;
          p_template_id: string | null;
          p_token: string | null;
          p_type: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_decide: {
        Args: {
          p_actor: string | null;
          p_decision: string | null;
          p_doc: string | null;
          p_expected_hash: string | null;
          p_ip?: string | null;
          p_note: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_doctor_events: {
        Args: { p_actor: string | null; p_limit?: number };
        Returns: Json;
      };
      clinical_document_doctor_view: {
        Args: {
          p_actor: string | null;
          p_doc: string | null;
          p_ip?: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_expire_due: { Args: Record<PropertyKey, never>; Returns: number };
      clinical_document_issue: {
        Args: {
          p_actor: string | null;
          p_doc: string | null;
          p_ip?: string | null;
          p_pdf_path: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_log_notification: {
        Args: { p_channel: string | null; p_doc: string | null; p_ok: boolean };
        Returns: undefined;
      };
      clinical_document_prepare: {
        Args: { p_actor: string | null; p_doc: string | null; p_issue_date: string | null };
        Returns: Json;
      };
      clinical_document_revoke: {
        Args: {
          p_actor: string | null;
          p_doc: string | null;
          p_ip?: string | null;
          p_reason: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_set_provider_request: {
        Args: { p_actor: string | null; p_doc: string | null; p_request_id: string | null };
        Returns: Json;
      };
      clinical_document_signing_failed: {
        Args: {
          p_actor: string | null;
          p_cancelled?: boolean;
          p_code: string | null;
          p_doc: string | null;
          p_ip?: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_submit: {
        Args: {
          p_actor: string | null;
          p_doc: string | null;
          p_ip?: string | null;
          p_rendered: string | null;
          p_snapshot_hash: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_update_draft: {
        Args: {
          p_actor: string | null;
          p_clinical: Json;
          p_doc: string | null;
          p_expires_at: string | null;
          p_ip?: string | null;
          p_prescription: Json;
          p_set_expiry?: boolean;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      clinical_document_void: {
        Args: {
          p_actor: string | null;
          p_doc: string | null;
          p_ip?: string | null;
          p_reason: string | null;
          p_ua?: string | null;
        };
        Returns: Json;
      };
      doctor_admin_set_status: {
        Args: {
          p_actor: string | null;
          p_doctor_id: string | null;
          p_note: string | null;
          p_prescribing_authorised?: boolean;
          p_signature_provider?: string | null;
          p_signature_provider_ref?: string | null;
          p_signature_status?: string | null;
          p_status: string | null;
        };
        Returns: Json;
      };
      doctor_admin_upsert: {
        Args: { p_actor: string | null; p_data: Json; p_user_id: string | null };
        Returns: Json;
      };
      doctor_assign_patient: {
        Args: {
          p_actor: string | null;
          p_assign: boolean;
          p_doctor_id: string | null;
          p_member_id: string | null;
        };
        Returns: Json;
      };
      doctor_list_documents: { Args: { p_actor: string | null }; Returns: Json };
      doctor_list_patients: { Args: { p_actor: string | null }; Returns: Json };
      doctor_update_own_profile: { Args: { p_actor: string | null; p_data: Json }; Returns: Json };
      document_verify_blocked: {
        Args: { p_bucket: string | null; p_limit: number; p_window_seconds: number };
        Returns: boolean;
      };
      document_verify_lookup: { Args: { p_token: string | null }; Returns: Json };
      document_verify_rate_check: {
        Args: { p_bucket: string | null; p_limit: number; p_window_seconds: number };
        Returns: boolean;
      };
      document_verify_record: {
        Args: {
          p_doc: string | null;
          p_observed_hash: string | null;
          p_requester_hash: string | null;
          p_status: string | null;
          p_token: string | null;
        };
        Returns: undefined;
      };
      member_list_documents: { Args: { p_user: string | null }; Returns: Json };
      request_admin_create: {
        Args: {
          p_actor: string | null;
          p_doctor: string | null;
          p_idempotency_key: string | null;
          p_member: string | null;
          p_reference: string | null;
          p_type: string | null;
        };
        Returns: Json;
      };
      request_assign: {
        Args: { p_actor: string | null; p_doctor: string | null; p_request: string | null };
        Returns: Json;
      };
      request_cancel: { Args: { p_actor: string | null; p_request: string | null }; Returns: Json };
      request_create: {
        Args: {
          p_actor: string | null;
          p_idempotency_key: string | null;
          p_note: string | null;
          p_type: string | null;
        };
        Returns: Json;
      };
      request_decline: {
        Args: { p_actor: string | null; p_reason: string | null; p_request: string | null };
        Returns: Json;
      };
      request_link_document: {
        Args: { p_actor: string | null; p_doc: string | null; p_request: string | null };
        Returns: Json;
      };
      request_list_admin: {
        Args: { p_actor: string | null; p_status?: string | null };
        Returns: Json;
      };
      request_list_doctor: { Args: { p_actor: string | null }; Returns: Json };
      request_list_member: { Args: { p_user: string | null }; Returns: Json };
      signature_policy_set: {
        Args: {
          p_actor: string | null;
          p_note: string | null;
          p_required: string | null;
          p_type: string | null;
        };
        Returns: Json;
      };
      signature_provider_set: {
        Args: {
          p_actor: string | null;
          p_assurance: string | null;
          p_enabled: boolean;
          p_note: string | null;
          p_provider: string | null;
        };
        Returns: Json;
      };
      template_create: {
        Args: {
          p_actor: string | null;
          p_content: string | null;
          p_name: string | null;
          p_note: string | null;
          p_schema: Json;
          p_type: string | null;
        };
        Returns: Json;
      };
      template_decide: {
        Args: {
          p_actor: string | null;
          p_approve: boolean;
          p_effective_until?: string | null;
          p_note: string | null;
          p_template_id: string | null;
        };
        Returns: Json;
      };
      template_list: { Args: { p_actor: string | null }; Returns: Json };
      template_new_version: {
        Args: {
          p_actor: string | null;
          p_content: string | null;
          p_note: string | null;
          p_schema: Json;
          p_template_id: string | null;
        };
        Returns: Json;
      };
      template_retire: {
        Args: {
          p_actor: string | null;
          p_note: string | null;
          p_revoke: boolean;
          p_template_id: string | null;
        };
        Returns: Json;
      };
      template_submit: {
        Args: { p_actor: string | null; p_template_id: string | null };
        Returns: Json;
      };
      template_update_draft: {
        Args: {
          p_actor: string | null;
          p_content: string | null;
          p_note: string | null;
          p_schema: Json;
          p_template_id: string | null;
        };
        Returns: Json;
      };
      // </clinical-functions>
      // <m4-functions>
      accrue_order_loyalty: { Args: { p_order_id: string }; Returns: Json };
      checkout_place_order: {
        Args: {
          p_address_id: string;
          p_contact_name: string;
          p_contact_phone: string;
          p_delivery_method: string;
          p_expected_total: number;
          p_idempotency_key: string;
          p_items: Json;
          p_notes: string | null;
          p_payment_method: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      checkout_quote: { Args: { p_delivery_method: string; p_items: Json }; Returns: Json };
      claim_back_in_stock_notifications: { Args: { p_limit?: number }; Returns: Json };
      create_reorder: {
        Args: {
          p_expected_total: number;
          p_idempotency_key: string;
          p_source_order_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      member_delete_address: { Args: { p_address_id: string; p_user_id: string }; Returns: Json };
      member_save_address: {
        Args: {
          p_address_id: string | null;
          p_data: Json;
          p_make_default?: boolean;
          p_user_id: string;
        };
        Returns: Json;
      };
      member_set_default_address: {
        Args: { p_address_id: string; p_user_id: string };
        Returns: Json;
      };
      redeem_loyalty_points: {
        Args: {
          p_idempotency_key: string;
          p_order_id: string;
          p_points: number;
          p_user_id: string;
        };
        Returns: Json;
      };
      reorder_check: { Args: { p_order_id: string; p_user_id: string }; Returns: Json };
      reverse_order_loyalty: { Args: { p_order_id: string }; Returns: Json };
      verification_log_document_view: {
        Args: { p_actor: string; p_user_id: string };
        Returns: Json;
      };
      verification_review: {
        Args: {
          p_actor: string;
          p_decision: string;
          p_idempotency_key: string;
          p_note: string | null;
          p_rejection_code: string | null;
          p_user_id: string;
        };
        Returns: Json;
      };
      verification_submit: {
        Args: {
          p_document_path: string;
          p_document_type: string;
          p_dob: string;
          p_idempotency_key: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      // </m4-functions>
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
