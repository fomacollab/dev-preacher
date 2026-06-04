import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram/tl/index.js';
import { Account, AdminWithoutSessions, Customer, FinderMessage, System } from '../models/db.js';

// Global storage for active monitoring clients
let monitoringClients = new Map();
let reconnectIntervals = new Map();
let ownUserIds = new Set(); // Stores Telegram user IDs of our own accounts (preachers + source)

async function loadOwnUserIds() {
  console.log('🔄 Loading own account user IDs...');
  ownUserIds.clear();
  
  const accounts = await Account.find({ role: { $in: ['source', 'preacher'] } });
  
  for (const account of accounts) {
    try {
      const tempClient = new TelegramClient(
        new StringSession(account.session),
        parseInt(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 3 }
      );
      await tempClient.connect();
      const me = await tempClient.getMe();
      ownUserIds.add(me.id.toString());
      await tempClient.disconnect();
    } catch (error) {
      console.warn(`Could not load user ID for account ${account.number}:`, error.message || error);
    }
  }
  
  console.log(`✅ Loaded ${ownUserIds.size} own account user IDs`);
}

// Create Telegram client for monitoring
function createMonitoringClient(session) {
  const apiId = parseInt(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  const stringSession = new StringSession(session);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    timeout: 30000,
    requestRetries: 3,
    autoReconnect: true,
  });

  // Suppress logs
  client.setLogLevel('none');

  return client;
}

// Send notification to admin
const truncate50 = (text = '') => {
  const cleaned = (text || '').toString().replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 750) return cleaned;
  return `${cleaned.slice(0, 747)}...`;
};

async function getAdminUserIds() {
  const userIds = new Set();

  const adminAccounts = await Account.find({ admin: true, adminUserId: { $ne: null } }, { adminUserId: 1 });
  for (const acc of adminAccounts) {
    if (acc.adminUserId) userIds.add(acc.adminUserId.toString());
  }

  const adminsNoSessions = await AdminWithoutSessions.find({}, { userId: 1 });
  for (const admin of adminsNoSessions) {
    if (admin.userId) userIds.add(admin.userId.toString());
  }

  return Array.from(userIds);
}

async function getPreacherUserIds() {
  // Get all preachers and source accounts and their Telegram user IDs
  const userIds = new Set();
  const accounts = await Account.find({ role: { $in: ['preacher', 'source'] } });
  
  for (const account of accounts) {
    // We need to get the account's own Telegram user ID
    // To do this, we need to use the session to fetch 'me' OR we can try to get from other places
    // Wait, actually, when we add an account, we don't store the account's own user ID in the DB
    // So instead, let's create a list of usernames/numbers and also try to check via session
    // For this check, let's first try to get any cached info, but also, let's add a check
    // First, let's get all possible user IDs we can
  }
  
  return userIds;
}

async function notifyAdmins(message, extra = {}) {
  try {
    if (!global.bot) return;

    const adminUserIds = await getAdminUserIds();
    if (adminUserIds.length === 0) return;

    await Promise.allSettled(
      adminUserIds.map((userId) =>
        global.bot.telegram.sendMessage(userId, message, extra)
      )
    );
  } catch (error) {
    console.error('❌ Error sending admin notification:', error);
  }
}

const extractUsernameFromLink = (link = '') => {
  if (!link) return null;
  let normalized = link.trim();
  normalized = normalized.replace(/^https?:\/\//i, '');
  normalized = normalized.replace(/^t\.me\//i, '');
  normalized = normalized.replace(/^telegram\.me\//i, '');
  normalized = normalized.split('/')[0];
  normalized = normalized.split('?')[0];
  normalized = normalized.replace('@', '').trim();
  return normalized || null;
};

const buildMessageLink = async (client, message) => {
  try {
    const chat = await message.getChat();
    if (chat?.username) {
      return `https://t.me/${chat.username}/${message.id}`;
    }

    const chatIdStr = (message.chatId || chat?.id)?.toString?.() || '';
    if (chatIdStr.startsWith('-100')) {
      return `https://t.me/c/${chatIdStr.slice(4)}/${message.id}`;
    }
    if (chatIdStr.startsWith('-')) {
      return `https://t.me/c/${chatIdStr.slice(1)}/${message.id}`;
    }
    return '';
  } catch {
    return '';
  }
};

async function getDumpGroupId() {
  const doc = await System.findOne({}, { dumpGroupId: 1 });
  return doc?.dumpGroupId || null;
}

// --- HIGH-QUALITY DEV REQUEST FILTERING ---

// Keywords that indicate a DEV REQUEST (not just random mentions)
const REQUEST_INDICATORS = [
  'need', 'looking for', 'want', 'hire', 'help with', 'someone to', 'can someone',
  'anyone can', 'looking to', 'want to', 'need to', 'help me', 'assist with',
  'create', 'make', 'develop', 'build', 'setup', 'set up', 'fix', 'repair',
  'update', 'upgrade', 'design', 'implement', 'integrate', 'automate',
  'required', 'looking for a', 'need a', 'want a', 'hire a', 'find a',
  'searching for', 'seeking', 'in need of', 'urgent', 'asap',
  'anyone here', 'any developer', 'any dev', 'anybody here', 'who would like',
  'available for', 'work with me', 'connect with', 'dm me', 'message me',
  'contact me', 'i have a task', 'task for', 'needed', 'developers needed',
  'looking', 'searching'
];

// Tech/Dev keywords we care about
const DEV_KEYWORDS = [
  'website', 'web app', 'web application', 'web platform', 'landing page',
  'telegram bot', 'tg bot', 'bot', 'automation', 'automate',
  'software', 'app', 'application', 'platform', 'dashboard', 'crm',
  'full stack', 'fullstack', 'frontend', 'backend', 'api', 'rest api',
  'react', 'next.js', 'nextjs', 'node.js', 'nodejs', 'express', 'mongodb',
  'database', 'db', 'ecommerce', 'e-commerce', 'store', 'shop',
  'developer', 'dev', 'programmer', 'coder', 'engineer', 'software engineer',
  'wordpress', 'shopify', 'woocommerce', 'firebase', 'supabase',
  'mobile app', 'android', 'ios', 'flutter', 'react native',
  'php', 'laravel', 'ui/ux', 'ux/ui', 'ui designer', 'ux designer',
  'game dev', 'game developer', 'blockchain', 'sql', 'voip', 'clone',
  'ai website', 'ai developer', 'email hacker', 'colour trading',
  'website creater', 'website creator', 'devloper', 'expert'
];

// Spam patterns to EXCLUDE
const SPAM_PATTERNS = [
  /\b(free|giveaway|win|prize|discount|sale|offer)\b/i,
  /\b(join|subscribe|follow|like|share)\b/i,
  /\b(sex|nude|porn|xxx|adult)\b/i,
  /\b(hack|hacking|hacked)\b/i,
  /^Join\s/i, // Join messages
  /@sujini_official_bot/i, // Ignore the Sujini bot messages
];

/**
 * Check if message is SPAM
 */
const isSpam = (text = '') => {
  const cleanText = (text || '').trim();
  if (cleanText.length < 5) return true; // Too short, likely spam
  
  return SPAM_PATTERNS.some(pattern => pattern.test(cleanText));
};

/**
 * Check if message is a HIGH-QUALITY DEV REQUEST
 * Must have:
 * 1. At least one REQUEST INDICATOR OR is a direct dev request pattern
 * 2. At least one DEV KEYWORD
 * 3. NOT spam
 */
const isHighQualityDevRequest = (text = '') => {
  const lower = (text || '').toLowerCase().trim();
  
  if (isSpam(text)) return false;
  
  // Check for direct dev request patterns (like "Anyone web developer?")
  const directRequestPatterns = [
    /anyone .* (developer|dev|engineer|programmer)/i,
    /any .* (developer|dev|engineer|programmer)/i,
    /(developer|dev|engineer|programmer) .* dm/i,
    /need .* (developer|dev|engineer|programmer|bot|website)/i,
    /looking for .* (developer|dev|engineer|programmer|bot|website)/i,
    /seeking .* (developer|dev|engineer|programmer|bot|website)/i,
  ];
  
  const isDirectRequest = directRequestPatterns.some(pattern => pattern.test(text));
  const hasRequestIndicator = REQUEST_INDICATORS.some(indicator => lower.includes(indicator));
  const hasDevKeyword = DEV_KEYWORDS.some(keyword => lower.includes(keyword));
  
  return (isDirectRequest || hasRequestIndicator) && hasDevKeyword;
};

// Reconnect monitoring for a specific account
async function reconnectMonitoring(account, accountUsername) {
  try {
    console.log(`🔄 Reconnecting monitoring for ${accountUsername}...`);
    
    // Stop existing monitoring for this account
    const existing = monitoringClients.get(account.number);
    if (existing && existing.client) {
      try {
        if (existing.client.connected) {
          await existing.client.disconnect();
        }
      } catch (e) {
        // Ignore disconnect errors
      }
    }

    // Clear any existing reconnect interval
    if (reconnectIntervals.has(account.number)) {
      clearInterval(reconnectIntervals.get(account.number));
      reconnectIntervals.delete(account.number);
    }

    // Wait a bit before reconnecting
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Start monitoring again
    await startMonitoringAccount(account);

  } catch (error) {
    console.error(`❌ Error reconnecting ${accountUsername}:`, error);
  }
}

// Start monitoring for a single account
async function startMonitoringAccount(account) {
  try {
    const client = createMonitoringClient(account.session);
    await client.connect();

    // Get account username
    const me = await client.getMe();
    await client.invoke(new Api.updates.GetState()).catch(() => {});
    await client.getDialogs({ limit: 20 }).catch(() => {});
    const accountUsername = me.username ? `@${me.username}` : account.number;

    monitoringClients.set(account.number, { client, username: accountUsername });

    console.log(`✅ Monitoring started for admin account: ${accountUsername}`);

    const queue = [];
    let processing = false;

    const handleNewMessageEvent = async (event) => {
      const message = event.message;

      if (message.out) return;

      const sender = await message.getSender();
      const username = sender.username ? `@${sender.username}` : 'No username';
      const userId = sender.id.toString();
      const content = message.text || '[Media message]';
      
      // Skip messages from our own accounts!
      if (ownUserIds.has(userId)) {
        return;
      }

      if (event.isPrivate) {
        const existingCustomer = await Customer.findOne({ userId: userId });

        if (!existingCustomer) {
          const customer = new Customer({
            username: username,
            userId: userId,
            textedAt: new Date(),
            type: 'dm',
            content: content,
            senderAccount: account.number,
          });

          await customer.save();

          const notificationMessage = `📩 New DM to ${accountUsername}\n\nFrom: ${username} | ID: ${userId}\n\nMessage: ${truncate50(content)}`;
          await notifyAdmins(notificationMessage);
        }
        return;
      }

      if (event.isGroup && message.replyTo && message.replyTo.replyToMsgId) {
        try {
          const chat = await message.getChat();
          const repliedToMsg = await client.getMessages(message.peerId, { ids: [message.replyTo.replyToMsgId] });

          if (repliedToMsg && repliedToMsg[0] && repliedToMsg[0].out) {
            const existingCustomer = await Customer.findOne({ userId: userId });
            if (!existingCustomer) {
              const customer = new Customer({
                username: username,
                userId: userId,
                textedAt: new Date(),
                type: 'reply',
                content: content,
                senderAccount: account.number,
                groupId: chat?.id?.toString?.() || null,
              });
              await customer.save();
            }

            const link = await buildMessageLink(client, message);
            const groupName = chat?.title || 'Unknown Group';
            const notificationMessage = `📩 New reply to ${accountUsername}\n\nFrom: ${username} | ID: ${userId}\n\nGroup: ${groupName}\nLink: ${link}\n\nMessage: ${truncate50(content)}`;
            await notifyAdmins(notificationMessage, { disable_web_page_preview: true });
            return;
          }
        } catch {
          // ignore reply-check errors
        }
      }

      if (event.isGroup && !event.isPrivate) {
        const dumpGroupId = await getDumpGroupId();
        if (!dumpGroupId) return;

        if (!content || content === '[Media message]') return;
        if (!isHighQualityDevRequest(content)) return;

        const existingCustomer = await Customer.findOne({ userId: userId });
        if (existingCustomer) return;

        const link = await buildMessageLink(client, message);
        if (!link) return;

        console.log(`🔍 Keyword detected in message from ${username}`);

        const customer = new Customer({
          username: username,
          userId: userId,
          textedAt: new Date(),
          type: 'finding-a-dev',
          content: truncate50(content),
          senderAccount: account.number,
          groupId: (message.chatId || '').toString?.() || null,
        });
        await customer.save();

        const chat = await message.getChat();
        const groupName = chat?.title || 'Unknown Group';

        const dumpText =
          `From: ${username} | ID: ${userId}\n` +
          `Group: ${groupName}\n\n` +
          `Message: ${truncate50(content)}\n\n` +
          `Link: ${link}\n\n` +
          `Click "Completed" when done`;

        const sent = await global.bot.telegram.sendMessage(
          dumpGroupId,
          dumpText,
          {
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[{ text: '✅ Completed', callback_data: 'finder_done_pending' }]],
            },
          }
        );

        const finder = await FinderMessage.create({
          dumpGroupId: dumpGroupId.toString(),
          dumpMessageId: sent.message_id,
          sourceChatId: (message.chatId || '').toString(),
          sourceMessageId: message.id,
          sourceLink: link,
          senderUserId: userId,
          preview: truncate50(content),
        });

        await global.bot.telegram.editMessageReplyMarkup(
          dumpGroupId,
          sent.message_id,
          undefined,
          { inline_keyboard: [[{ text: '✅ Completed', callback_data: `finder_done:${finder._id.toString()}` }]] }
        );

        console.log(`✅ Forwarded to dump group: ${dumpGroupId}`);
      }
    };

    const processQueue = async () => {
      if (processing) return;
      processing = true;
      try {
        while (queue.length) {
          const event = queue.shift();
          if (!event) continue;
          try {
            await handleNewMessageEvent(event);
          } catch (err) {
            console.error(`Error processing queued message for ${accountUsername}:`, err);
          }
        }
      } finally {
        processing = false;
      }
    };

    // Set up disconnect handler
    client.addEventHandler(async (update) => {
      if (update.className === 'UpdateConnectionState') {
        console.log(`⚠️ Connection state changed for ${accountUsername}`);
        
        // If disconnected, try to reconnect after delay
        if (!client.connected) {
          console.log(`❌ ${accountUsername} disconnected - scheduling reconnect`);
          setTimeout(() => {
            reconnectMonitoring(account, accountUsername);
          }, 10000);
        }
      }
    });

    client.addEventHandler(
      async (event) => {
        try {
          const message = event.message;
          if (!message || message.out) return;
          queue.push(event);
          processQueue().catch(() => {});
        } catch (error) {
          console.error(`Error processing message for ${accountUsername}:`, error);
          // Don't let individual message errors crash the entire monitoring
        }
      },
      new NewMessage({ incoming: true })
    );

    // Set up periodic health check
    const healthCheckInterval = setInterval(async () => {
      try {
        if (!client.connected) throw new Error('not_connected');
        await client.getMe();
        await client.invoke(new Api.updates.GetState()).catch(() => {});
      } catch (error) {
        console.error(`Health check error for ${accountUsername}:`, error);
        clearInterval(healthCheckInterval);
        reconnectMonitoring(account, accountUsername);
      }
    }, 30000);

    // Store health check interval
    reconnectIntervals.set(account.number, healthCheckInterval);

  } catch (error) {
    const errorMsg = error?.errorMessage || error?.message || '';
    const errorCode = error?.code;
    
    console.error(`❌ Error starting monitoring for account ${account.number}:`, error);
    
    // Retry after delay if initial connection fails
    setTimeout(() => {
      console.log(`🔄 Retrying monitoring for ${account.number}...`);
      startMonitoringAccount(account);
    }, 30000);
  }
}

// Start monitoring for SOURCE account only
export async function startMessageMonitoring() {
  try {
    // Load our own user IDs first
    await loadOwnUserIds();
    
    const systemDoc = await System.findOne({});
    if (!systemDoc || !systemDoc.sourceAccountId) {
      console.log('ℹ️ No source account found for monitoring');
      console.log('⚠️ Please add a source account to enable keyword detection');
      return;
    }

    const sourceAccount = await Account.findById(systemDoc.sourceAccountId);
    if (!sourceAccount) {
      console.log('⚠️ Source account not found');
      return;
    }

    console.log(`🚀 Starting message monitoring with source account (${sourceAccount.username || sourceAccount.number})...`);
    
    await startMonitoringAccount(sourceAccount);
    
    console.log(`✅ Message monitoring started for source account`);

  } catch (error) {
    console.error('❌ Error starting message monitoring:', error);
  }
}

// Stop monitoring for all accounts
export async function stopMessageMonitoring() {
  try {
    // Clear all health check intervals
    for (const interval of reconnectIntervals.values()) {
      clearInterval(interval);
    }
    reconnectIntervals.clear();

    const disconnectPromises = Array.from(monitoringClients.values()).map(async (clientData) => {
      try {
        const client = clientData.client || clientData;
        if (client && client.connected) {
          await client.disconnect();
        }
      } catch (error) {
        // Silently handle disconnect errors
      }
    });

    await Promise.allSettled(disconnectPromises);
    monitoringClients.clear();

    console.log('✅ Message monitoring stopped');

  } catch (error) {
    console.error('❌ Error stopping message monitoring:', error);
  }
}

// Restart monitoring when new accounts are added
export async function restartMonitoring() {
  await stopMessageMonitoring();
  await new Promise(resolve => setTimeout(resolve, 3000));
  await loadOwnUserIds(); // Reload own user IDs when restarting
  await startMessageMonitoring();
}
