const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate required env vars are present before any logic
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[api/checkout] STRIPE_SECRET_KEY is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const { priceId, userId, email } = req.body;

  if (!priceId || !userId || !email) {
    return res.status(400).json({ error: 'priceId, userId, and email are required' });
  }

  // Validate against server-side env vars — never trust client-supplied price IDs blindly
  const allowedPrices = [
    process.env.STRIPE_PRO_PRICE_ID,
    process.env.STRIPE_ELITE_PRICE_ID,
  ].filter(Boolean);

  if (allowedPrices.length === 0) {
    console.error('[api/checkout] STRIPE_PRO_PRICE_ID and STRIPE_ELITE_PRICE_ID are not set in env');
    return res.status(500).json({ error: 'Server configuration error: price IDs not configured' });
  }

  if (!allowedPrices.includes(priceId)) {
    return res.status(400).json({ error: 'Invalid price ID' });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.betintel.bet';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      client_reference_id: userId,
      success_url: `${siteUrl}/?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${siteUrl}/?status=cancelled`,
      subscription_data: {
        metadata: { userId, priceId },
      },
      allow_promotion_codes: true,
    });

    console.log(`[api/checkout] Created session ${session.id} for user ${userId}`);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[api/checkout]', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session. Please try again.' });
  }
};
