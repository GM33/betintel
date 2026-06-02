const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: false } };
// NOTE: bodyParser must be disabled so we can read the raw body for Stripe signature verification.
// In Vercel, this is done by NOT using Next.js API routes — the raw body is available via req stream.

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getTierFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_ELITE_PRICE_ID) return 'elite';
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return 'pro';
  return 'pro'; // safe fallback
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  try {
    switch (event.type) {

      // ── User completes checkout → upgrade tier
      case 'checkout.session.completed': {
        const userId = obj.client_reference_id;
        if (!userId) {
          console.warn('[webhook] checkout.session.completed missing client_reference_id');
          break;
        }

        // Retrieve the subscription to get the actual price ID
        // session.subscription_data is NOT the subscription object — must retrieve it
        const subscription = await stripe.subscriptions.retrieve(obj.subscription);
        const priceId = subscription.items.data[0]?.price?.id;
        const tier = getTierFromPriceId(priceId);

        const { error } = await supabase
          .from('profiles')
          .upsert({
            id: userId,
            tier,
            stripe_customer_id: obj.customer,
            stripe_subscription_id: obj.subscription,
            updated_at: new Date().toISOString(),
          });

        if (error) console.error('[webhook] Supabase upsert error:', error.message);
        else console.log(`[webhook] User ${userId} upgraded to ${tier} (price: ${priceId})`);
        break;
      }

      // ── Subscription changed (upgrade/downgrade mid-cycle)
      case 'customer.subscription.updated': {
        const customerId = obj.customer;
        const priceId = obj.items.data[0]?.price?.id;
        const tier = getTierFromPriceId(priceId);
        const status = obj.status;

        // Only sync if subscription is still active
        if (status === 'active' || status === 'trialing') {
          const { error } = await supabase
            .from('profiles')
            .update({ tier, updated_at: new Date().toISOString() })
            .eq('stripe_customer_id', customerId);

          if (error) console.error('[webhook] Supabase update error:', error.message);
          else console.log(`[webhook] Customer ${customerId} updated to ${tier} (status: ${status})`);
        } else {
          // Subscription became inactive — downgrade
          const { error } = await supabase
            .from('profiles')
            .update({ tier: 'free', updated_at: new Date().toISOString() })
            .eq('stripe_customer_id', customerId);

          if (error) console.error('[webhook] Supabase downgrade error:', error.message);
          else console.log(`[webhook] Customer ${customerId} downgraded to free (status: ${status})`);
        }
        break;
      }

      // ── Subscription cancelled → downgrade to free
      case 'customer.subscription.deleted': {
        const customerId = obj.customer;
        const { error } = await supabase
          .from('profiles')
          .update({
            tier: 'free',
            stripe_subscription_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('[webhook] Supabase delete error:', error.message);
        else console.log(`[webhook] Customer ${customerId} downgraded to free (subscription deleted)`);
        break;
      }

      // ── Payment failed — log for monitoring
      case 'invoice.payment_failed': {
        console.warn('[webhook] Payment failed — customer:', obj.customer, '| invoice:', obj.id);
        break;
      }

      // ── Payment succeeded — log for audit trail
      case 'invoice.payment_succeeded': {
        console.log('[webhook] Payment succeeded — customer:', obj.customer, '| amount:', obj.amount_paid);
        break;
      }

      default:
        console.log(`[webhook] Unhandled event: ${event.type}`);
    }
  } catch (err) {
    console.error('[webhook] Handler error:', err.message, err.stack);
    return res.status(500).json({ error: 'Handler failed' });
  }

  return res.status(200).json({ received: true });
};
