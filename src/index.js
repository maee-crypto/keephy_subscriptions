#!/usr/bin/env node

/**
 * Keephy Subscriptions Service
 * Manages user subscriptions and billing
 */

import express from 'express';
import mongoose from 'mongoose';
import pino from 'pino';
import pinoHttp from 'pino-http';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
const PORT = process.env.PORT || 3020;

// Stripe configuration
const stripe = new Stripe(process.env.STRIPE_KEY || 'sk_test_...', {
  apiVersion: '2023-10-16'
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '10mb' }));

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/keephy_enhanced';

mongoose.connect(MONGODB_URI)
  .then(() => logger.info('Connected to MongoDB'))
  .catch(err => logger.error('MongoDB connection error:', err));

// Subscription Schema
const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
  stripeSubscriptionId: String,
  stripeCustomerId: String,
  status: {
    type: String,
    enum: ['active', 'canceled', 'past_due', 'unpaid', 'trialing', 'incomplete'],
    default: 'active'
  },
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  cancelAtPeriodEnd: { type: Boolean, default: false },
  trialStart: Date,
  trialEnd: Date,
  price: Number,
  currency: { type: String, default: 'USD' },
  interval: { type: String, enum: ['monthly', 'yearly', 'lifetime'] },
  features: [{
    name: String,
    included: Boolean,
    limit: Number
  }],
  limits: {
    franchises: Number,
    forms: Number,
    submissions: Number,
    staff: Number,
    storage: Number,
    apiCalls: Number
  },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Subscription = mongoose.model('Subscription', subscriptionSchema);

// Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'keephy_subscriptions',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/ready', async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ status: 'ready', service: 'keephy_subscriptions' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Get user subscription
app.get('/api/subscriptions/user/:userId', async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      userId: req.params.userId,
      isActive: true
    }).populate('planId');
    
    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: 'No active subscription found'
      });
    }
    
    res.json({
      success: true,
      data: subscription
    });
  } catch (error) {
    logger.error('Error fetching user subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch subscription'
    });
  }
});

// Create subscription
app.post('/api/subscriptions', async (req, res) => {
  try {
    const { userId, planId, businessId, stripeCustomerId, paymentMethodId } = req.body;
    
    if (!userId || !planId) {
      return res.status(400).json({
        success: false,
        error: 'User ID and Plan ID are required'
      });
    }
    
    // Get plan details
    const plan = await mongoose.model('Plan').findById(planId);
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found'
      });
    }
    
    // Create Stripe subscription
    let stripeSubscription;
    if (stripeCustomerId && paymentMethodId) {
      stripeSubscription = await stripe.subscriptions.create({
        customer: stripeCustomerId,
        items: [{ price: plan.stripePriceId }],
        default_payment_method: paymentMethodId,
        expand: ['latest_invoice.payment_intent']
      });
    }
    
    const subscription = new Subscription({
      userId,
      planId,
      businessId,
      stripeSubscriptionId: stripeSubscription?.id,
      stripeCustomerId,
      status: stripeSubscription?.status || 'active',
      currentPeriodStart: stripeSubscription?.current_period_start ? 
        new Date(stripeSubscription.current_period_start * 1000) : new Date(),
      currentPeriodEnd: stripeSubscription?.current_period_end ? 
        new Date(stripeSubscription.current_period_end * 1000) : 
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      price: plan.price,
      currency: plan.currency,
      interval: plan.interval,
      features: plan.features,
      limits: plan.limits
    });
    
    await subscription.save();
    
    res.status(201).json({
      success: true,
      data: subscription
    });
  } catch (error) {
    logger.error('Error creating subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create subscription'
    });
  }
});

// Update subscription
app.put('/api/subscriptions/:id', async (req, res) => {
  try {
    const { planId, status, cancelAtPeriodEnd } = req.body;
    
    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: 'Subscription not found'
      });
    }
    
    // Update Stripe subscription if needed
    if (subscription.stripeSubscriptionId) {
      if (planId) {
        const plan = await mongoose.model('Plan').findById(planId);
        if (plan) {
          await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
            items: [{ price: plan.stripePriceId }]
          });
        }
      }
      
      if (cancelAtPeriodEnd !== undefined) {
        await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
          cancel_at_period_end: cancelAtPeriodEnd
        });
      }
    }
    
    // Update local subscription
    const updateData = { updatedAt: new Date() };
    if (planId) updateData.planId = planId;
    if (status) updateData.status = status;
    if (cancelAtPeriodEnd !== undefined) updateData.cancelAtPeriodEnd = cancelAtPeriodEnd;
    
    const updatedSubscription = await Subscription.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    ).populate('planId');
    
    res.json({
      success: true,
      data: updatedSubscription
    });
  } catch (error) {
    logger.error('Error updating subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update subscription'
    });
  }
});

// Cancel subscription
app.delete('/api/subscriptions/:id', async (req, res) => {
  try {
    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: 'Subscription not found'
      });
    }
    
    // Cancel Stripe subscription
    if (subscription.stripeSubscriptionId) {
      await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
    }
    
    // Update local subscription
    subscription.status = 'canceled';
    subscription.isActive = false;
    await subscription.save();
    
    res.json({
      success: true,
      message: 'Subscription canceled successfully'
    });
  } catch (error) {
    logger.error('Error canceling subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel subscription'
    });
  }
});

// Start free trial
app.post('/api/subscriptions/free-trial', async (req, res) => {
  try {
    const { userId, planId, businessId, trialDays = 14 } = req.body;
    
    if (!userId || !planId) {
      return res.status(400).json({
        success: false,
        error: 'User ID and Plan ID are required'
      });
    }
    
    const plan = await mongoose.model('Plan').findById(planId);
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found'
      });
    }
    
    const trialEnd = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    
    const subscription = new Subscription({
      userId,
      planId,
      businessId,
      status: 'trialing',
      trialStart: new Date(),
      trialEnd,
      price: plan.price,
      currency: plan.currency,
      interval: plan.interval,
      features: plan.features,
      limits: plan.limits
    });
    
    await subscription.save();
    
    res.status(201).json({
      success: true,
      data: subscription
    });
  } catch (error) {
    logger.error('Error starting free trial:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start free trial'
    });
  }
});

// Stripe webhook handler
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      logger.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle the event
    switch (event.type) {
      case 'customer.subscription.updated':
        const subscription = event.data.object;
        await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: subscription.id },
          {
            status: subscription.status,
            currentPeriodStart: new Date(subscription.current_period_start * 1000),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            cancelAtPeriodEnd: subscription.cancel_at_period_end
          }
        );
        break;
        
      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object;
        await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: deletedSubscription.id },
          { status: 'canceled', isActive: false }
        );
        break;
        
      default:
        logger.info(`Unhandled event type: ${event.type}`);
    }
    
    res.json({ received: true });
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Keephy Subscriptions Service running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  mongoose.connection.close();
  process.exit(0);
});
