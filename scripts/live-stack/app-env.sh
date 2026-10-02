# Source after /tmp/live.env (see scripts/live-stack/README.md). Points the app at the local stack.
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
export SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
export VITE_SUPABASE_URL=http://127.0.0.1:54321
export VITE_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
export VITE_SUPABASE_PROJECT_ID=local
# Lets live specs call the scheduled maintenance endpoint (ID-image retention sweep).
export LOVABLE_CRON_SECRET=live-cron-secret

# Local mock Yoco / PayPal (scripts/live-stack/mock-providers.mjs) so the payment flows run end to end offline.
export MOCK_PORT=4599
export YOCO_SECRET_KEY=sk_test_live_mock
export YOCO_WEBHOOK_SECRET="whsec_$(printf 'live-mock-yoco-secret-0123456789' | base64)"
export YOCO_API_BASE=http://127.0.0.1:4599
export PAYPAL_CLIENT_ID=mock-client PAYPAL_CLIENT_SECRET=mock-secret PAYPAL_WEBHOOK_ID=MOCK-WH PAYPAL_MERCHANT_ID=MOCK-MERCHANT PAYPAL_ENV=sandbox
export PAYPAL_API_BASE=http://127.0.0.1:4599
