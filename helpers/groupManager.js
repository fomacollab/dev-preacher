import { Account, System } from '../models/db.js';
import { fetchAccountGroups, joinGroup, leaveGroup } from './telegram.js';

/**
 * Fetch and update groups for source account only
 */
export async function fetchAllAccountGroups() {
  const systemDoc = await System.findOne({});
  if (!systemDoc || !systemDoc.sourceAccountId) {
    console.log('⚠️ No source account found');
    return;
  }

  const sourceAccount = await Account.findById(systemDoc.sourceAccountId);
  if (!sourceAccount) {
    console.log('⚠️ Source account not found');
    return;
  }

  console.log(`📡 Fetching groups for source account (${sourceAccount.username || sourceAccount.number})...`);
  
  const groups = await fetchAccountGroups(sourceAccount.session);
  
  if (groups) {
    await Account.updateOne(
      { _id: sourceAccount._id },
      { $set: { groups: groups } }
    );
    console.log(`   ✅ Updated ${groups.length} groups for source account`);
  } else {
    console.log(`   ⚠️ Failed to fetch groups for source account`);
  }
}

/**
 * Ensure only one preacher per group (mutual with source)
 */
export async function handleDuplicateGroups() {
  const systemDoc = await System.findOne({});
  if (!systemDoc || !systemDoc.sourceAccountId) {
    console.log('⚠️ No source account found');
    return;
  }

  const sourceAccount = await Account.findById(systemDoc.sourceAccountId);
  const preachers = await Account.find({ role: 'preacher' });
  
  if (!sourceAccount) {
    console.log('⚠️ Source account not found');
    return;
  }

  // Get all source group IDs
  const sourceGroupIds = new Set(sourceAccount.groups.map(g => g.id));
  
  // Map group ID to assigned preachers
  const groupMap = new Map();
  for (const preacher of preachers) {
    for (const group of preacher.groups) {
      // Only consider groups that are also in source
      if (sourceGroupIds.has(group.id)) {
        if (!groupMap.has(group.id)) {
          groupMap.set(group.id, []);
        }
        groupMap.get(group.id).push(preacher);
      }
    }
  }
  
  // Find duplicates and remove extras
  for (const [groupId, accountsInGroup] of groupMap.entries()) {
    if (accountsInGroup.length > 1) {
      const shuffled = [...accountsInGroup].sort(() => Math.random() - 0.5);
      const toLeave = shuffled.slice(0, -1);
      
      for (const preacher of toLeave) {
        console.log(`   ℹ️ ${preacher.username || preacher.number} leaving duplicate group ${groupId}`);
        await leaveGroup(preacher.session, groupId);
        await Account.updateOne(
          { _id: preacher._id },
          { $pull: { groups: { id: groupId } } }
        );
      }
    }
  }
}

/**
 * Find groups where source is in but no preacher is assigned
 */
export async function findAdminOnlyGroups() {
  const systemDoc = await System.findOne({});
  if (!systemDoc || !systemDoc.sourceAccountId) {
    return [];
  }

  const sourceAccount = await Account.findById(systemDoc.sourceAccountId);
  const preachers = await Account.find({ role: 'preacher' });
  
  if (!sourceAccount) {
    return [];
  }

  // Get all groups that preachers are in
  const preacherGroupIds = new Set();
  for (const preacher of preachers) {
    for (const group of preacher.groups) {
      preacherGroupIds.add(group.id);
    }
  }
  
  // Find source groups with no preachers
  return sourceAccount.groups.filter(g => !preacherGroupIds.has(g.id));
}

/**
 * Sync source account groups and assign new ones to preachers (one per group)
 */
export async function syncAdminGroupsAndDistribute() {
  const systemDoc = await System.findOne({});
  if (!systemDoc || !systemDoc.sourceAccountId) {
    return { newGroups: 0, assigned: 0, failed: 0, details: [] };
  }

  const sourceAccount = await Account.findById(systemDoc.sourceAccountId);
  const preachers = await Account.find({ role: 'preacher' });
  
  if (!sourceAccount) {
    return { newGroups: 0, assigned: 0, failed: 0, details: [] };
  }

  console.log(`🔄 Syncing source account groups...`);

  const fetchedGroups = await fetchAccountGroups(sourceAccount.session);
  if (!fetchedGroups) {
    return { newGroups: 0, assigned: 0, failed: 0, details: [] };
  }

  // Find new groups
  const existingIds = new Set((sourceAccount.groups || []).map(g => g.id));
  const newGroups = fetchedGroups.filter(g => !existingIds.has(g.id));
  
  // Update source account groups
  const mergedMap = new Map();
  for (const g of (sourceAccount.groups || [])) mergedMap.set(g.id, g);
  for (const g of fetchedGroups) mergedMap.set(g.id, g);
  const mergedGroups = Array.from(mergedMap.values());
  
  await Account.updateOne({ _id: sourceAccount._id }, { $set: { groups: mergedGroups } });

  const details = [];
  let assigned = 0;
  let failed = 0;

  // Assign each new group to a random preacher
  for (const group of newGroups) {
    // Find preachers not already in this group
    const availablePreachers = preachers.filter(p => 
      p.session && !(p.groups || []).some(g => g.id === group.id)
    );

    if (availablePreachers.length === 0) {
      failed++;
      details.push({ group: group.name, status: 'no_available_preachers' });
      continue;
    }

    // Pick random preacher
    const chosenPreacher = availablePreachers[Math.floor(Math.random() * availablePreachers.length)];
    const joinTarget = group.link || group.name || group.id;
    const joinSuccess = await joinGroup(chosenPreacher.session, joinTarget);

    if (!joinSuccess) {
      failed++;
      details.push({ 
        group: group.name, 
        status: 'join_failed', 
        preacher: chosenPreacher.username || chosenPreacher.number 
      });
      continue;
    }

    // Update preacher's groups
    await Account.updateOne(
      { _id: chosenPreacher._id },
      { $push: { groups: { ...group } } }
    );

    assigned++;
    details.push({ 
      group: group.name, 
      status: 'assigned', 
      preacher: chosenPreacher.username || chosenPreacher.number 
    });
  }

  return { 
    newGroups: newGroups.length, 
    assigned, 
    failed, 
    details 
  };
}
