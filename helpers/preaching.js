import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { joinGroup, leaveGroup, fetchAccountGroups } from './telegram.js';
import { Account, AdminWithoutSessions, System } from '../models/db.js';
import { devMessages } from '../utils/devMessages.js';

// Helper to get source group IDs from DB
async function getSourceGroupIds() {
  const systemDoc = await System.findOne();
  if (!systemDoc || !systemDoc.sourceAccountId) {
    return new Set();
  }
  const sourceAccount = await Account.findById(systemDoc.sourceAccountId);
  if (!sourceAccount) {
    return new Set();
  }
  return new Set(sourceAccount.groups.map(g => g.id));
}

// Global control variables
let preachingActive = false;
let preachingController = null;
let activeClients = new Map();

// Comprehensive user agent pool
const getUserAgent = () => {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

const getRandomDeviceModel = () => {
  const devices = [
    "Desktop", "Laptop", "iPhone15,2", "SM-G998B", "Pixel 8",
    "MacBookPro18,1", "ThinkPad X1", "Dell XPS 13", "iPad13,1"
  ];
  return devices[Math.floor(Math.random() * devices.length)];
};

const getRandomSystemVersion = () => {
  const versions = ["10.0", "11.0", "14.1.1", "10.15.7", "13.6.1", "Ubuntu 22.04"];
  return versions[Math.floor(Math.random() * versions.length)];
};

const getRandomAppVersion = () => {
  const major = Math.floor(Math.random() * 5) + 8;
  const minor = Math.floor(Math.random() * 10);
  const patch = Math.floor(Math.random() * 20);
  return `${major}.${minor}.${patch}`;
};

const getRandomLangCode = () => {
  const langs = ["en", "en-US", "en-GB", "es", "fr"];
  return langs[Math.floor(Math.random() * langs.length)];
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const CHANNEL_ID_BIAS = 1000000000000n;

const getAdminUserIds = async () => {
  const userIds = new Set();
  const admins = await Account.find({ admin: true, adminUserId: { $ne: null } }, { adminUserId: 1 });
  for (const a of admins) {
    if (a.adminUserId) userIds.add(a.adminUserId.toString());
  }
  const noSessions = await AdminWithoutSessions.find({}, { userId: 1 });
  for (const a of noSessions) {
    if (a.userId) userIds.add(a.userId.toString());
  }
  return Array.from(userIds);
};

const notifyAdmins = async (message) => {
  try {
    if (!global.bot) return;
    const ids = await getAdminUserIds();
    if (ids.length === 0) return;
    await Promise.allSettled(ids.map((id) => global.bot.telegram.sendMessage(id, message)));
  } catch {
    // ignore
  }
};

const normalizeUsername = (value = '') => {
  if (!value) return null;
  const cleaned = value.replace('@', '').trim().toLowerCase();
  return cleaned || null;
};

const extractUsernameFromLink = (link = '') => {
  if (!link) return null;
  let normalized = link.trim();
  normalized = normalized.replace(/^https?:\/\//i, '');
  normalized = normalized.replace(/^t\.me\//i, '');
  normalized = normalized.replace(/^telegram\.me\//i, '');
  normalized = normalized.split('/')[0];
  normalized = normalized.split('?')[0];
  return normalizeUsername(normalized);
};

const buildEntityCache = (dialogs = []) => {
  const cache = new Map();
  for (const dialog of dialogs) {
    const entity = dialog?.entity;
    if (!entity) continue;

    if (entity.id !== undefined && entity.id !== null) {
      cache.set(entity.id.toString(), entity);
    }

    if (entity.username) {
      cache.set(normalizeUsername(entity.username), entity);
    }
  }
  return cache;
};

const isNumericId = (value) => {
  if (typeof value === 'bigint') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    return /^-?\d+$/.test(value.trim());
  }
  return false;
};

const toBigIntId = (value) => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value);
};

const resolveEntityFromCache = (entityCache, group) => {
  if (!entityCache || !group) return null;
  const candidates = [];
  if (group.id) candidates.push(group.id.toString());
  const usernameFromLink = extractUsernameFromLink(group.link);
  if (usernameFromLink) candidates.push(usernameFromLink);
  if (group.username) candidates.push(normalizeUsername(group.username));

  for (const key of candidates) {
    if (key && entityCache.has(key)) {
      return entityCache.get(key);
    }
  }
  return null;
};

const resolveGroupEntity = async (client, group, entityCache) => {
  if (!group) {
    throw new Error('Missing group information');
  }

  const cachedEntity = resolveEntityFromCache(entityCache, group);
  if (cachedEntity) {
    return cachedEntity;
  }

  const usernameFromLink = extractUsernameFromLink(group.link);
  const usernameCandidates = [];
  if (usernameFromLink) usernameCandidates.push(usernameFromLink);
  if (group.username) usernameCandidates.push(normalizeUsername(group.username));

  for (const username of usernameCandidates) {
    if (!username) continue;
    try {
      const entity = await client.getEntity(username);
      if (entityCache) {
        entityCache.set(group.id?.toString() || username, entity);
      }
      return entity;
    } catch (error) {
      // Try next candidate
    }
  }

  if (group.id && isNumericId(group.id)) {
    const numericId = toBigIntId(group.id);
    const idCandidates = new Set();
    idCandidates.add(numericId);
    idCandidates.add(-numericId);
    idCandidates.add(-CHANNEL_ID_BIAS - numericId);
    idCandidates.add(-CHANNEL_ID_BIAS + numericId);

    for (const candidate of idCandidates) {
      try {
        const entity = await client.getEntity(candidate);
        if (entityCache) {
          entityCache.set(group.id.toString(), entity);
        }
        return entity;
      } catch (error) {
        continue;
      }
    }
  }

  throw new Error(`Unable to resolve entity for ${group.name || group.id}`);
};

// Get today's date string (YYYY-MM-DD)
const getTodayDate = () => {
  const today = new Date();
  return today.toISOString().split('T')[0];
};

// Get remaining hours until end of day
const getRemainingHoursToday = () => {
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  
  const remainingMs = endOfDay - now;
  const remainingHours = remainingMs / (1000 * 60 * 60);
  
  return remainingHours;
};

// Calculate interval between messages for a group
// Split 24 hours evenly by msgPerDay (default 5 = 4.8 hours per message)
const calculateMessageInterval = (group) => {
  const today = getTodayDate();
  // Only consider today's tracker - ignore old trackers from previous days
  const todayTracker = group.dailyTracker?.find(t => t.date === today);
  
  const messagesSent = todayTracker?.messageCount || 0;
  const messagesRemaining = group.msgPerDay - messagesSent;
  
  if (messagesRemaining <= 0) {
    return null;
  }
  
  // Split 24 hours evenly by msgPerDay
  // If msgPerDay is 5, each interval is 24/5 = 4.8 hours
  const intervalHours = 24 / group.msgPerDay;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  
  return intervalMs;
};

// Calculate how many messages a group should have sent since last message
const calculateMissedMessages = (group) => {
  const today = getTodayDate();
  // Only consider today's tracker - ignore old trackers from previous days
  const todayTracker = group.dailyTracker?.find(t => t.date === today);
  
  if (!todayTracker || !todayTracker.lastSentAt) {
    return 0;
  }
  
  const timeSinceLastSend = Date.now() - new Date(todayTracker.lastSentAt).getTime();
  const requiredInterval = calculateMessageInterval(group);
  
  if (requiredInterval === null) {
    return 0;
  }
  
  const missedIntervals = Math.floor(timeSinceLastSend / requiredInterval);
  const messagesSent = todayTracker.messageCount || 0;
  const maxPossibleMessages = Math.min(missedIntervals, group.msgPerDay - messagesSent);
  
  return Math.max(0, maxPossibleMessages);
};

// Handle catch-up for groups that missed multiple messages
const handleCatchUp = async (group, account, lastUsedMessageId) => {
  const missedMessages = calculateMissedMessages(group);
  
  if (missedMessages <= 1) {
    return { shouldSend: true, catchUpMode: false };
  }
  
  console.log(`  🔄 Catch-up: ${group.name} (${missedMessages} messages behind)`);
  
  return { shouldSend: true, catchUpMode: true };
};

// Create Telegram client with fingerprinting
function createClient(session) {
  const apiId = parseInt(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  const stringSession = new StringSession(session);
  
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: getRandomDeviceModel(),
    systemVersion: getRandomSystemVersion(),
    appVersion: getRandomAppVersion(),
    langCode: getRandomLangCode(),
    systemLangCode: getRandomLangCode(),
    useIPv6: Math.random() < 0.3,
    userAgent: getUserAgent(),
  });
  
  client.setLogLevel('none');
  
  return client;
}

// Sync single preacher's groups to DB
const syncPreacherGroups = async (account, client) => {
  try {
    const dialogs = await client.getDialogs({ limit: 500 });
    const groups = [];
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      const groupName = (entity.title || '').toLowerCase();
      const groupLink = entity.username ? `https://t.me/${entity.username}`.toLowerCase() : '';
      
      // EXPLICITLY SKIP & LEAVE t.me/mynewlink GROUP!
      if (groupName.includes('mynewlink') || groupLink.includes('mynewlink')) {
        console.log(`  🚫 Found mynewlink group for ${account.username || account.number} - leaving it immediately!`);
        try {
          await leaveGroup(account.session, entity.id.toString());
        } catch (leaveErr) {
          console.log('    Warning: could not leave mynewlink group');
        }
        continue;
      }
      
      if (entity.className === 'Chat' || (entity.className === 'Channel' && entity.megagroup)) {
        groups.push({
          id: entity.id.toString(),
          name: entity.title || 'Unnamed Group',
          link: entity.username ? `https://t.me/${entity.username}` : null,
          msgPerDay: 5,
          lastMessageId: 0
        });
      }
    }
    
    // Update DB
    await Account.updateOne(
      { _id: account._id },
      { $set: { groups } }
    );
    return { success: true, groups };
  } catch (error) {
    console.error('  ❌ Error syncing groups for', account.username || account.number, error);
    return { success: false };
  }
};

// Handle account errors
const handleAccountError = async (error, accountNumber) => {
  const msg = error?.errorMessage?.toUpperCase() || error?.message?.toUpperCase() || '';
  const code = error?.code;

  if (msg.includes('CHAT_WRITE_FORBIDDEN') || 
      msg.includes('CHAT_ADMIN_REQUIRED') ||
      msg.includes('USER_BANNED_IN_CHANNEL') ||
      msg.includes('CHAT_SEND_') ||
      msg.includes('SLOWMODE_WAIT_') ||
      msg.includes('CHANNEL_INVALID') ||
      msg.includes('CHANNEL_PRIVATE') ||
      msg.includes('MSG_ID_INVALID') ||
      msg.includes('PEER_ID_INVALID')) {
    return { isGroupError: true };
  }

  if (code === 420 || msg.includes('FLOOD_WAIT')) {
    return { isFloodWait: true };
  }

  if (code === 401 && (msg.includes('AUTH_KEY_UNREGISTERED') || msg.includes('SESSION_REVOKED'))) {
    console.error(`❌ [${accountNumber}] Session revoked - logging out`);
    
    const alertMsg = `🚫 Account logged out:\n${accountNumber}\n\nAccount removed from database.`;
    
    try {
      await notifyAdmins(alertMsg);
      await Account.findOneAndDelete({ number: accountNumber });
    } catch (cleanupError) {
      // Silently handle cleanup errors
    }
    
    return { isCritical: true };
  }

  if (code === 400 && msg.includes('AUTH_BYTES_INVALID')) {
    console.error(`❌ [${accountNumber}] Corrupted session - logging out`);
    
    const alertMsg = `🚫 Corrupted session:\n${accountNumber}\n\nAccount removed from database.`;
    
    try {
      await notifyAdmins(alertMsg);
      await Account.findOneAndDelete({ number: accountNumber });
    } catch (cleanupError) {
      // Silently handle cleanup errors
    }
    
    return { isCritical: true };
  }

  if (code === 406 && msg.includes('AUTH_KEY_DUPLICATED')) {
    console.error(`⚠️ [${accountNumber}] Auth key duplicated - another session in use elsewhere!`);
    
    const alertMsg = `⚠️ Duplicate session detected:\n${accountNumber}\n\nThis account is logged in somewhere else! If you want to use it in both bots, you need to re-login here to get a new session!`;
    
    try {
      await notifyAdmins(alertMsg);
    } catch (cleanupError) {
      // Silently handle cleanup errors
    }
    
    // Don't delete the account, just skip processing for now
    return { isOtherError: true };
  }

  if (msg.includes('USER_DEACTIVATED')) {
    console.error(`❌ [${accountNumber}] Account deactivated - logging out`);
    
    const alertMsg = `🚫 Account deactivated:\n${accountNumber}\n\nAccount removed from database.`;
    
    try {
      await notifyAdmins(alertMsg);
      await Account.findOneAndDelete({ number: accountNumber });
    } catch (cleanupError) {
      // Silently handle cleanup errors
    }
    
    return { isCritical: true };
  }

  return { isOtherError: true };
};

// Update daily tracker for a group
const updateDailyTracker = async (accountId, groupId) => {
  // This function previously read & saved the Account document and could cause VersionError
  // when other parts of the code were updating the same document concurrently.
  // The actual tracker updates are handled in incrementDailyTracker using atomic updates.
  // To avoid version conflicts, this function is now a no-op that always succeeds.
  return true;
};

// Update daily tracker after successful message send (using atomic update to avoid version conflicts)
const incrementDailyTracker = async (accountId, groupId) => {
  const today = getTodayDate();
  const now = new Date().toISOString();
  
  try {
    // Use atomic MongoDB operations to avoid version conflicts
    const account = await Account.findById(accountId);
    if (!account) {
      console.error(`Account ${accountId} not found`);
      return false;
    }

    const groupIndex = account.groups.findIndex(g => g.id === groupId);
    if (groupIndex === -1) {
      console.error(`Group ${groupId} not found`);
      return false;
    }

    // Find existing tracker or create new one atomically
    const group = account.groups[groupIndex];
    const existingTracker = group.dailyTracker?.find(t => t.date === today);
    
    if (existingTracker) {
      // Update existing tracker atomically
      await Account.updateOne(
        { _id: accountId, [`groups.${groupIndex}.dailyTracker.date`]: today },
        {
          $inc: { [`groups.${groupIndex}.dailyTracker.$.messageCount`]: 1 },
          $set: { [`groups.${groupIndex}.dailyTracker.$.lastSentAt`]: now }
        }
      );
    } else {
      // Create new tracker atomically
      const newTracker = {
        date: today,
        messageCount: 1,
        lastSentAt: now
      };
      
      await Account.updateOne(
        { _id: accountId },
        {
          $push: {
            [`groups.${groupIndex}.dailyTracker`]: newTracker
          }
        }
      );
    }
    
    return true;
  } catch (error) {
    console.error(`Error updating tracker:`, error);
    // Fallback: retry with fresh document read
    try {
      const account = await Account.findById(accountId);
      if (!account) return false;
      
      const group = account.groups.find(g => g.id === groupId);
      if (!group) return false;
      
      if (!group.dailyTracker) {
        group.dailyTracker = [];
      }
      
      let todayTracker = group.dailyTracker.find(t => t.date === today);
      if (!todayTracker) {
        todayTracker = { 
          date: today, 
          messageCount: 0,
          lastSentAt: null
        };
        group.dailyTracker.push(todayTracker);
      }
      
      todayTracker.messageCount += 1;
      todayTracker.lastSentAt = now;
      
      // Use updateOne instead of save to avoid version conflicts
      await Account.updateOne(
        { _id: accountId },
        { $set: { groups: account.groups } }
      );
      
      return true;
    } catch (retryError) {
      console.error(`Retry failed:`, retryError);
      return false;
    }
  }
};

// Check if group has reached daily limit
const hasReachedDailyLimit = (group) => {
  const today = getTodayDate();
  // Only check today's tracker - ignore old trackers from previous days
  const todayTracker = group.dailyTracker?.find(t => t.date === today);
  
  if (!todayTracker) return false;
  
  return todayTracker.messageCount >= group.msgPerDay;
};

// Get a random message ID that is different from the last one used
const getRandomMessageId = (lastUsedId) => {
  const totalMessages = Object.keys(devMessages).length;
  
  // If there's only one message, return it
  if (totalMessages === 1) {
    return 1;
  }
  
  // Generate a random ID between 1 and totalMessages
  let randomId;
  do {
    randomId = Math.floor(Math.random() * totalMessages) + 1;
  } while (randomId === lastUsedId && totalMessages > 1); // Ensure it's different from last used
  
  return randomId;
};

// Get message by ID
const getMessageById = (messageId) => {
  const messageText = devMessages[messageId];
  
  if (!messageText) {
    // Fallback to first message if ID is invalid
    return {
      id: 1,
      text: devMessages[1] || "Hey! Developer available for projects. DM me if you need help!"
    };
  }
  
  return {
    id: messageId,
    text: messageText
  };
};

// Get random delay between messages
const getRandomDelay = () => {
  return Math.floor(Math.random() * 6000) + 2000;
};

// Calculate the next earliest time when any group will be ready
const getNextEarliestReadyTime = async () => {
  try {
    const sourceGroupIds = await getSourceGroupIds();
    const accounts = await Account.find({ role: 'preacher' });
    let earliestReadyTime = null;
    let earliestGroupInfo = null;
    const today = getTodayDate();
    
    // FIRST: Check if any group hasn't sent today (should send immediately)
    for (const account of accounts) {
      const accountLabel = account.username ? `@${account.username}` : account.number;
      for (const group of account.groups) {
        if (!sourceGroupIds.has(group.id)) continue;
        if (group.name?.toLowerCase().includes('mynewlink') || group.link?.toLowerCase().includes('mynewlink')) continue;
        if (hasReachedDailyLimit(group)) {
          continue;
        }
        
        const todayTracker = group.dailyTracker?.find(t => t.date === today);
        
        // If no tracker for today OR no lastSentAt, group is ready NOW
        if (!todayTracker || !todayTracker.lastSentAt) {
          return { readyTime: 0, groupInfo: `${accountLabel}:${group.name}` };
        }
      }
    }
    
    // SECOND: If all groups have sent today, find the next one ready
    for (const account of accounts) {
      const accountLabel = account.username ? `@${account.username}` : account.number;
      for (const group of account.groups) {
        if (!sourceGroupIds.has(group.id)) continue;
        if (group.name?.toLowerCase().includes('mynewlink') || group.link?.toLowerCase().includes('mynewlink')) continue;
        if (hasReachedDailyLimit(group)) {
          continue;
        }
        
        const requiredInterval = calculateMessageInterval(group);
        if (requiredInterval === null) {
          continue;
        }
        
        const todayTracker = group.dailyTracker?.find(t => t.date === today);
        
        if (!todayTracker || !todayTracker.lastSentAt) {
          // This shouldn't happen since we checked above, but just in case
          return { readyTime: 0, groupInfo: `${accountLabel}:${group.name}` };
        }
        
        const timeSinceLastSend = Date.now() - new Date(todayTracker.lastSentAt).getTime();
        const timeUntilReady = requiredInterval - timeSinceLastSend;
        
        if (timeUntilReady <= 0) {
          return { readyTime: 0, groupInfo: `${accountLabel}:${group.name}` };
        }
        
        if (earliestReadyTime === null || timeUntilReady < earliestReadyTime) {
          earliestReadyTime = timeUntilReady;
          earliestGroupInfo = `${accountLabel}:${group.name}`;
        }
      }
    }
    
    // If no groups found, all are done for today
    if (earliestReadyTime === null) {
      return { readyTime: 10 * 60 * 1000, groupInfo: null };
    }
    
    return {
      readyTime: earliestReadyTime,
      groupInfo: earliestGroupInfo
    };
  } catch (error) {
    console.error('Error calculating next ready time:', error);
    return { readyTime: 10 * 60 * 1000, groupInfo: 'Error occurred' };
  }
};

// Check if group has sufficient activity
// Only send if the last 8 messages don't include our messages (to avoid spam)
const checkGroupActivity = async (client, group, accountUsername, entityCache) => {
  try {
    const me = await client.getMe();
    const myUserId = me.id.toString();

    try {
      const entity = await resolveGroupEntity(client, group, entityCache);
      const messages = await client.getMessages(entity, { limit: 8 });
      
      if (!messages || messages.length === 0) {
        return { hasActivity: true };
      }

      const hasOurMessage = messages.some(msg => {
        const senderId = msg.senderId?.toString() || msg.fromId?.userId?.toString();
        return senderId === myUserId;
      });

      if (hasOurMessage) {
        return { hasActivity: false, reason: 'Our message still in recent 8' };
      }

      return { hasActivity: true };
    } catch (resolveError) {
      console.warn(`  ⚠️ [${accountUsername}] Could not check activity for ${group.name}: ${resolveError.message}`);
      return { hasActivity: true };
    }

    return { hasActivity: true };

  } catch (error) {
    console.warn(`  ⚠️ [${accountUsername}] Activity check failed for ${group.name}: ${error.message}`);
    return { hasActivity: true };
  }
};

// Send message to a group
const sendMessageToGroup = async (client, group, message, accountUsername, accountNumber, entityCache) => {
  try {
    // FINAL CHECK: Verify group is still in source account's groups BEFORE sending!
    const sourceGroupIds = await getSourceGroupIds();
    if (!sourceGroupIds.has(group.id)) {
      console.log(`  ⛔ [${accountUsername}] Group ${group.name} is no longer in source account - skipping!`);
      return { success: false, skipGroup: true };
    }

    const entity = await resolveGroupEntity(client, group, entityCache);
    await client.sendMessage(entity, { message: message });
    return { success: true };
    
  } catch (error) {
    console.error(`  ❌ [${accountUsername}] Failed to send to ${group.name}: ${error.message}`);
    const errorResult = await handleAccountError(error, accountNumber);
    
    if (errorResult.isGroupError) {
      return { success: false, skipGroup: true };
    }
    
    if (errorResult.isCritical) {
      return { success: false, critical: true };
    }
    
    if (errorResult.isFloodWait) {
      return { success: false, floodWait: true };
    }
    
    if (errorResult.isOtherError) {
      return { success: false, otherError: true };
    }
    
    return { success: false, otherError: true };
  }
};

// Process a single preacher account
const processAccount = async (account, sourceAccount) => {
  let client = null;
  
  try {
    client = createClient(account.session);
    await client.connect();
    
    activeClients.set(account.number, client);
    
    // Get account username for logging
    let accountUsername = account.username ? `@${account.username}` : account.number;
    try {
      const me = await client.getMe();
      if (me.username) {
        accountUsername = `@${me.username}`;
      }
    } catch (e) {
      // Use account.username or number as fallback
    }
    
    // 🔹 Step 1: SYNC PREACHER'S GROUPS TO DB
    console.log(`  🔄 [${accountUsername}] Syncing groups to DB...`);
    const syncResult = await syncPreacherGroups(account, client);
    if (!syncResult.success) {
      console.log(`  ⚠️ [${accountUsername}] Could not sync groups, skipping`);
      return;
    }
    account.groups = syncResult.groups; // Update local account
    
    // 🔹 Step 2: Get SOURCE ACCOUNT'S GROUPS DIRECTLY FROM THE DATABASE!
    const sourceGroupIds = await getSourceGroupIds();
    if (sourceGroupIds.size === 0) {
      console.log(`  ⚠️ [${accountUsername}] No valid source groups in DB, skipping`);
      return;
    }
    console.log(`  ℹ️ [${accountUsername}] Using ${sourceGroupIds.size} source account groups from DB`);
    
    // Step 3: Build entity cache for preacher
    let entityCache = null;
    try {
      const dialogs = await client.getDialogs();
      entityCache = buildEntityCache(dialogs);
    } catch (error) {
      console.warn(`  ⚠️ [${accountUsername}] Could not build entity cache: ${error.message}`);
      entityCache = new Map();
    }
    
    // Step 4: Get all other preachers to avoid duplicates
    const allPreachers = await Account.find({ role: 'preacher', _id: { $ne: account._id } });
    const otherPreacherGroupIds = new Set();
    const otherPreacherGroups = new Map();
    for (const preacher of allPreachers) {
      const preacherLabel = preacher.username ? `@${preacher.username}` : preacher.number;
      for (const group of preacher.groups) {
        otherPreacherGroupIds.add(group.id);
        if (!otherPreacherGroups.has(group.id)) {
          otherPreacherGroups.set(group.id, []);
        }
        otherPreacherGroups.get(group.id).push(preacherLabel);
      }
    }
    
    let messagesSent = 0;
    let lastUsedMessageId = account.currentMessageId || 0;
    
    // Step 5: ONLY VALID GROUPS:
    // 1. Must be in source account's DB groups
    // 2. Must NOT have another preacher there
    // 3. NOT mynewlink
    const validGroups = account.groups.filter(group => {
      // Check 1: Is this group in the source account's DB groups?
      if (!sourceGroupIds.has(group.id)) {
        return false;
      }
      
      // Check 2: Is another preacher already in this group?
      if (otherPreacherGroupIds.has(group.id)) {
        return false;
      }
      
      // Check 3: Is this mynewlink?
      if ((group.name?.toLowerCase() || '').includes('mynewlink') || (group.link?.toLowerCase() || '').includes('mynewlink')) {
        return false;
      }
      
      return true;
    });
    
    console.log(`  ℹ️ [${accountUsername}] Checking ${validGroups.length}/${account.groups.length} valid groups`);
    
    for (const group of validGroups) {
      if (!preachingActive || preachingController?.signal.aborted) {
        break;
      }
      
      // Check if another preacher is already in this group!
      if (otherPreacherGroups.has(group.id)) {
        const otherPreachers = otherPreacherGroups.get(group.id);
        console.log(`  🔄 [${accountUsername}] Found other preachers (${otherPreachers.join(', ')}) in ${group.name} - leaving group!`);
        
        // Leave the group
        await leaveGroup(account.session, group.id);
        
        // Remove this group from our DB
        const updatedGroups = account.groups.filter(g => g.id !== group.id);
        await Account.updateOne(
          { _id: account._id },
          { $set: { groups: updatedGroups } }
        );
        // Update local array too
        account.groups = updatedGroups;
        
        continue;
      }
      
      let entity;
      try {
        if (entityCache.has(group.id)) {
          entity = entityCache.get(group.id);
        } else {
          entity = await resolveGroupEntity(client, group, entityCache);
        }
        
        // 1. Skip regular channels
        if (entity && entity.className === 'Channel' && !entity.megagroup) {
          console.log(`  ⛔ [${accountUsername}] Skipping regular channel: ${group.name}`);
          continue;
        }
        
        // 2. Check if we are an admin/owner of this group!
        const me = await client.getMe();
        let isAdminOrOwner = false;
        
        try {
          if (entity.className === 'Chat') {
            // For basic chat, check if we are creator
            isAdminOrOwner = entity.creator === true || entity.adminRights !== undefined;
          } else if (entity.className === 'Channel' && entity.megagroup) {
            // For supergroups/channels, get participant
            const participant = await client.getParticipant(entity, me.id);
            isAdminOrOwner = participant && (participant.participant.className === 'ChannelParticipantCreator' || participant.participant.className === 'ChannelParticipantAdmin');
          }
        } catch (err) {
          // If we can't check admin status, skip just to be safe!
          console.log(`  ⚠️ [${accountUsername}] Could not check admin status in ${group.name}, skipping`);
          continue;
        }
        
        if (isAdminOrOwner) {
          console.log(`  ⛔ [${accountUsername}] Skipping group ${group.name} - we are admin/owner!`);
          continue;
        }
      } catch (error) {
        // If we can't verify anything, skip it just in case
        console.log(`  ⚠️ [${accountUsername}] Could not verify ${group.name}, skipping`);
        continue;
      }
      
      if (hasReachedDailyLimit(group)) {
        continue;
      }
      
      const today = getTodayDate();
      const todayTracker = group.dailyTracker?.find(t => t.date === today);
      
      // If no tracker exists for today OR tracker exists but no messages sent (messageCount is 0 or null), send immediately
      if (!todayTracker || !todayTracker.lastSentAt || (todayTracker.messageCount === 0 || todayTracker.messageCount == null)) {
        // Ready to send - continue
      } else {
        // Check interval only if we've already sent messages today AND messageCount > 0
        const requiredInterval = calculateMessageInterval(group);
        
        if (requiredInterval === null) {
          continue;
        }
        
        const timeSinceLastSend = Date.now() - new Date(todayTracker.lastSentAt).getTime();
        
        if (timeSinceLastSend < requiredInterval) {
          continue;
        }
      }
      
      const catchUpResult = await handleCatchUp(group, account, lastUsedMessageId);
      if (!catchUpResult.shouldSend) {
        continue;
      }
      
      await updateDailyTracker(account._id, group.id);
      
      // Get a random message ID that's different from the last one used
      const selectedMessageId = getRandomMessageId(lastUsedMessageId);
      const nextMessage = getMessageById(selectedMessageId);
      
      // Validate message before sending
      if (!nextMessage.text || nextMessage.text.trim() === '') {
        console.error(`  ❌ [${accountUsername}] Empty message for ${group.name} (ID: ${nextMessage.id})`);
        // Select a new random message ID and update
        lastUsedMessageId = getRandomMessageId(lastUsedMessageId);
        await Account.updateOne(
          { _id: account._id },
          { $set: { currentMessageId: lastUsedMessageId } }
        );
        continue;
      }
      
      console.log(`  📤 ${group.name} (${todayTracker ? todayTracker.messageCount + 1 : 1}/${group.msgPerDay})`);
      
      const activityCheck = await checkGroupActivity(client, group, accountUsername, entityCache);
      
      if (!activityCheck.hasActivity) {
        // Update currentMessageId even when skipping (to avoid repeating)
        lastUsedMessageId = selectedMessageId;
        await Account.updateOne(
          { _id: account._id },
          { $set: { currentMessageId: lastUsedMessageId } }
        );
        await incrementDailyTracker(account._id, group.id);
        console.log(`  ⏭️  ${group.name} - ${activityCheck.reason}`);
        const delay = getRandomDelay();
        await sleep(delay);
        continue;
      }
      
      const result = await sendMessageToGroup(client, group, nextMessage.text, accountUsername, account.number, entityCache);
      
      if (result?.success) {
        // Update currentMessageId with the randomly selected message ID
        lastUsedMessageId = selectedMessageId;
        await Account.updateOne(
          { _id: account._id },
          { $set: { currentMessageId: lastUsedMessageId } }
        );
        await incrementDailyTracker(account._id, group.id);
        messagesSent++;
        console.log(`  ✅ ${group.name}`);
        
        if (catchUpResult.catchUpMode) {
          const catchUpDelay = 30000 + Math.random() * 30000;
          await sleep(catchUpDelay);
        } else {
          const delay = getRandomDelay();
          await sleep(delay);
        }
      } else if (result?.critical) {
        console.log(`  🚨 Critical error - stopping account`);
        break;
      } else if (result?.skipGroup) {
        continue;
      } else if (result?.floodWait) {
        console.log(`  ⏸️  ${group.name} - flood wait`);
        await sleep(2000);
      } else if (result?.otherError) {
        // Update currentMessageId even on error (to avoid repeating)
        lastUsedMessageId = selectedMessageId;
        await Account.updateOne(
          { _id: account._id },
          { $set: { currentMessageId: lastUsedMessageId } }
        );
        await incrementDailyTracker(account._id, group.id);
        const delay = getRandomDelay();
        await sleep(delay);
      } else {
        // Update currentMessageId even on unknown error
        lastUsedMessageId = selectedMessageId;
        await Account.updateOne(
          { _id: account._id },
          { $set: { currentMessageId: lastUsedMessageId } }
        );
        await incrementDailyTracker(account._id, group.id);
        await sleep(2000);
      }
    }
    
    if (messagesSent === 0) {
      // Only log if no messages were sent and groups need messages
      const today = getTodayDate();
      let groupsNeedingMessages = 0;
      for (const group of validGroups) {
        if (hasReachedDailyLimit(group)) continue;
        const tracker = group.dailyTracker?.find(t => t.date === today);
        if (!tracker || !tracker.lastSentAt || tracker.messageCount === 0) {
          groupsNeedingMessages++;
        }
      }
      if (groupsNeedingMessages > 0) {
        console.log(`  ⚠️  ${accountUsername}: ${groupsNeedingMessages} groups need messages`);
      }
    }
    
  } catch (error) {
    const accountUsername = account.username ? `@${account.username}` : account.number;
    console.error(`Error processing ${accountUsername}:`, error.message);
    await handleAccountError(error, account.number);
  } finally {
    if (client && client.connected) {
      try {
        await client.disconnect();
      } catch (disconnectError) {
        // Silently handle disconnect errors
      }
    }
    activeClients.delete(account.number);
  }
};

/**
 * Start the preaching process
 */
export async function startPreaching(ctx) {
  if (preachingActive) {
    console.log('⚠️  Preaching is already active');
    if (ctx) {
      await ctx.reply('✅ Messages are already being sent!\n\nTo stop, use /stoppreaching');
    }
    return;
  }

  preachingActive = true;
  preachingController = new AbortController();

  if (ctx) {
    await ctx.reply('✅ Message sending started!\n\n📢 Dev messages will be sent to all mutual groups with smart timing.\n\nTo stop, use /stoppreaching');
  }

  console.log('🚀 Starting preaching system...');

  (async () => {
    while (preachingActive && !preachingController.signal.aborted) {
      try {
        // Get source account and its groups
        const systemDoc = await System.findOne();
        if (!systemDoc || !systemDoc.sourceAccountId) {
          console.log('⚠️ No source account found. Waiting...');
          await sleep(30000);
          continue;
        }
        
        const sourceAccount = await Account.findById(systemDoc.sourceAccountId);
        if (!sourceAccount) {
          console.log('⚠️ Source account not found. Waiting...');
          await sleep(30000);
          continue;
        }
        
        // Step 1: First, refresh source account's groups to get latest
        console.log('🔄 Refreshing source account groups...');
        const latestSourceGroups = await fetchAccountGroups(sourceAccount.session);
        if (latestSourceGroups) {
          await Account.updateOne({ _id: sourceAccount._id }, { $set: { groups: latestSourceGroups }});
          console.log(`   ✅ Updated source account groups to ${latestSourceGroups.length}`);
        }
        
        // Step 2: Get source group IDs from DB
        const sourceChatIds = await getSourceGroupIds();
        
        // Get preacher accounts
        const accounts = await Account.find({ role: 'preacher' });
        
        if (accounts.length === 0) {
          console.log('No preacher accounts found. Waiting...');
          await sleep(30000);
          continue;
        }

        console.log(`\n🔄 Processing ${accounts.length} preacher accounts...`);

        for (const account of accounts) {
          if (!preachingActive || preachingController.signal.aborted) {
            break;
          }
          
          await processAccount(account, sourceAccount);
          
          if (account !== accounts[accounts.length - 1]) {
            const accountDelay = 5000 + Math.random() * 5000;
            await sleep(accountDelay);
          }
        }

        console.log('✅ Cycle complete\n');

        // Check if there are any groups that haven't sent today
        const today = getTodayDate();
        let hasGroupsNeedingMessages = false;
        const currentSourceIds = await getSourceGroupIds();
        const allAccounts = await Account.find({ role: 'preacher' });
        for (const acc of allAccounts) {
          for (const grp of acc.groups) {
            if (!currentSourceIds.has(grp.id)) continue;
            if (hasReachedDailyLimit(grp)) {
              continue;
            }
            const tracker = grp.dailyTracker?.find(t => t.date === today);
            if (!tracker || !tracker.lastSentAt || tracker.messageCount === 0) {
              hasGroupsNeedingMessages = true;
              break;
            }
          }
          if (hasGroupsNeedingMessages) break;
        }

        while (preachingActive && !preachingController.signal.aborted) {
          const nextReady = await getNextEarliestReadyTime();
          
          // If groups need messages but we got "all done", something is wrong - retry immediately
          if (nextReady.readyTime === 10 * 60 * 1000 && nextReady.groupInfo === null) {
            if (hasGroupsNeedingMessages) {
              console.log('⚠️  Groups need messages but got "all done" - retrying immediately...\n');
              await sleep(5000); // Short delay before retry
              break; // Break to start new cycle
            }
            console.log('📅 All groups done for today. Waiting until tomorrow...');
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(1, 0, 0, 0);
            const waitUntilTomorrow = tomorrow.getTime() - now.getTime();
            await sleep(Math.min(waitUntilTomorrow, 24 * 60 * 60 * 1000));
            continue;
          }
          
          if (nextReady.readyTime <= 30000) {
            if (nextReady.readyTime > 0) {
              await sleep(nextReady.readyTime);
            }
            console.log('⚡ Group ready - starting new cycle\n');
            break;
          }
          
          const waitTimeMinutes = Math.ceil(nextReady.readyTime / (1000 * 60));
          const waitTimeHours = (waitTimeMinutes / 60).toFixed(1);
          
          console.log(`💤 Next group ready in ${waitTimeHours}h (${waitTimeMinutes}min)`);
          
          const checkInterval = 5 * 60 * 1000;
          const waitTime = Math.min(nextReady.readyTime, checkInterval);
          
          const actualWaitMinutes = Math.ceil(waitTime / (1000 * 60));
          console.log(`⏰ Sleeping ${actualWaitMinutes} min...\n`);
          
          await sleep(waitTime);
        }
        
      } catch (error) {
        console.error('❌ Error in preaching loop:', error.message);
        
        await notifyAdmins(`🚨 CRITICAL ERROR:\n\n${error.message}\n\nPlease check logs.`);
        
        await sleep(30000);
      }
    }
    
    console.log('🛑 Preaching system stopped');
  })();
}

/**
 * Stop the preaching process
 */
export async function stopPreaching(ctx) {
  if (!preachingActive) {
    console.log('ℹ️  Preaching is not active');
    if (ctx) {
      await ctx.reply('ℹ️  Messages are not currently being sent.\n\nTo start, use /startpreaching');
    }
    return;
  }

  console.log('🛑 Stopping preaching system...');

  preachingActive = false;

  if (preachingController) {
    preachingController.abort();
  }

  const disconnectPromises = Array.from(activeClients.values()).map(async (client) => {
    try {
      if (client && client.connected) {
        await client.disconnect();
      }
    } catch (error) {
      console.error('Error disconnecting client:', error);
    }
  });

  await Promise.allSettled(disconnectPromises);
  activeClients.clear();

  console.log('✅ All clients disconnected. Preaching system stopped.');

  if (ctx) {
    await ctx.reply('✅ Message sending stopped!\n\n📢 All accounts have been disconnected.\n\nTo start again, use /startpreaching');
  }
}