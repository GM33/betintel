const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const { priceId, userId, email } = req.body;

  const allowedPrices = [
    process.env.STRIPE_PRO_PRICE_ID,
    process.env.STRIPE_ELITE_PRICE_ID,
  ].filter(Boolean);

  if (!allowedPrices.includes(priceId)) {
    return res.status(400).json({ error: 'Invalid price ID' });
  }

  if (!userId || !email) {
    return res.status(400).json({ error: 'userId and email are required' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      client_reference_id: userId,
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL}/?status=cancelled`,
      subscription_data: {
        metadata: { userId, priceId },
      },
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[api/checkout]', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
