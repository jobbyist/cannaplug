# Go-live runbook: the first live day

For the owner and the manager on duty. Times are South African (SAST). Everything here can be done from `/admin` in a
browser; nothing needs a developer.

## What is live on day one

| Area                                                                 | Status on 25 Oct 2026                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Till (POS), receipts (print 80 mm / 58 mm / A4, PDF, email), cash-up | **Ready**                                                                                                                                             |
| Stock: receive, adjust, low-stock email, CSV product upload/edit     | **Ready**                                                                                                                                             |
| Staff accounts and roles (4 budtenders, 2 admins)                    | **Ready**                                                                                                                                             |
| Shop, member accounts, ID checks, loyalty                            | **Ready**                                                                                                                                             |
| Emails (dispatcher runs every 5 minutes from the database scheduler) | **Ready**                                                                                                                                             |
| Online payment                                                       | **Not yet.** Checkout shows "Online payment is being set up" until PayFast/PayPal keys are in Vercel or EFT details are confirmed in Admin → Payments |
| Phone notifications (web push)                                       | Waiting for the database step and VAPID keys                                                                                                          |
| Clinical documents                                                   | Waiting for a verified practitioner, approved templates and the signature policy                                                                      |

## Before opening (07:30–08:30)

1. Open `https://cannaplug012.co.za/api/public/health`: it must say `"status":"ok"` and `"db":"ok"`. `degraded` means emails
   are queued but not leaving; look at step 6 of "If something goes wrong".
2. **Close the old till session.** A session has been open since 2 Oct 12:29. A manager counts the drawer, closes it under
   Admin → POS → Close till, and approves the variance if asked. Then open today's session with the float.
3. Each budtender signs in once at `/account` with their own login, changes their password, and opens Admin → POS.
4. Check Admin → Inventory for anything that shows 0 but is on the shelf. Correct it with **Adjust stock**, reason
   "opening count".
5. Print one test receipt from a previous sale (Admin → POS → This session's sales → Receipt, or Find receipt) on the
   counter printer at 80 mm.

## First sales (opening hour)

1. Ring up the first real sale normally. Check the receipt prints and the stock count drops by the amount sold.
2. Email that receipt to a staff address you can open, to check email delivery (Resend).
3. Do one **refund** of a single low-value item (manager): stock returns, the refund receipt prints, the audit log shows it.

## Online orders (only once payment is configured)

- **PayFast:** place one real low-value order (R5 minimum) with card; check the order turns **Confirmed** by itself and
  the payment shows under Admin → Payments. Refund it in the PayFast dashboard, then cancel the order.
- **PayPal:** the same with a small order; the US-dollar amount follows the rate card in Admin → Payments.
- **EFT:** once the bank details are confirmed, place an order, pay it by EFT, and record it with **Confirm EFT received**.

## What to watch during the day

| Where                | Look for                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Admin → Payments     | Anything under **Needs attention**; EFTs waiting for a second manager                        |
| Admin → Orders       | Orders stuck in **Awaiting payment** (they release their stock automatically after the hold) |
| Admin → Audit log    | Unexpected voids, refunds, stock adjustments or price changes                                |
| `/api/public/health` | `status` stays `ok`                                                                          |
| Your inbox (info@)   | The daily low-stock email and staff alerts arrive                                            |

## Closing

1. Each till: count the drawer including the float → **Close till** → type the counted cash. A difference over R10 needs
   a reason and a different manager's approval.
2. A manager checks Admin → Audit log for the day and Admin → Payments for anything open.

## If something goes wrong

1. **A screen shows an error:** the message tells you what to do. Nothing is saved when an action fails. Note the time
   and what you clicked.
2. **The till won't sell an item:** check stock in Admin → Inventory; an unpaid online order may be holding it.
3. **A receipt email doesn't arrive:** print it instead; ask the customer to check spam.
4. **Checkout says online payment is being set up:** expected until the PayFast/PayPal keys or EFT details are in place;
   take orders in store.
5. **Wrong price on the shelf vs the till:** a manager edits the product (Admin → Products → Edit, or CSV upload); the
   till uses the new price immediately.
6. **Health says `degraded` for more than 15 minutes:** the scheduler is not reaching the site. In Supabase → SQL run
   `select * from net._http_response order by created desc limit 5;` and send the result to support.
7. **Roll back the site:** Vercel → Deployments → previous deployment → Promote. Database changes are additive and safe to
   leave in place (rollback scripts are in `supabase/rollbacks/`).
