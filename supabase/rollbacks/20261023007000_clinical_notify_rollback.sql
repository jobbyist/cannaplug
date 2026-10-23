-- Rollback for 20261023007000_clinical_notify. Refuses while prescription links exist (they record what staff relied on).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_prescription_links) THEN
    RAISE EXCEPTION 'prescription_links_present: export them before rolling back';
  END IF;
END;
$$;
DROP TRIGGER IF EXISTS document_requests_notify ON public.document_requests;
DROP TRIGGER IF EXISTS medical_documents_notify ON public.medical_documents;
DROP FUNCTION IF EXISTS public._document_requests_notify();
DROP FUNCTION IF EXISTS public._medical_documents_notify();
DROP FUNCTION IF EXISTS public._clinical_notify_user(uuid, text, text);
DROP FUNCTION IF EXISTS public.link_prescription_to_order(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.order_prescription_summaries(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.member_linkable_prescriptions(uuid);
DROP FUNCTION IF EXISTS public.doctor_search_documents(uuid, text, text, text, date, date, integer, integer);
DROP FUNCTION IF EXISTS public.clinical_readiness(uuid);
DROP TABLE IF EXISTS public.order_prescription_links;
