const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => resolve(Buffer.from(buf)));
    req.on('error', reject);
  });
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

  const session = event.data.object;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const userId = session.client_reference_id;
        const priceId = session.subscription_data?.metadata?.priceId;
        const tier = priceId === process.env.STRIPE_ELITE_PRICE_ID ? 'elite' : 'pro';
        await supabase
          .from('profiles')
          .upsert({ id: userId, tier, stripe_customer_id: session.customer, updated_at: new Date().toISOString() });
        console.log(`[webhook] User ${userId} upgraded to ${tier}`);
        break;
      }
      case 'customer.subscription.deleted': {
        const customerId = session.customer;
        await supabase
          .from('profiles')
          .update({ tier: 'free', updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', customerId);
        console.log(`[webhook] Customer ${customerId} downgraded to free`);
        break;
      }
      case 'invoice.payment_failed': {
        console.warn('[webhook] Payment failed for customer:', session.customer);
        break;
      }
      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error('[webhook] Handler error:', err.message);
    return res.status(500).json({ error: 'Handler failed' });
  }

  return res.status(200).json({ received: true });
};
