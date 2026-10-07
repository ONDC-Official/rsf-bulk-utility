import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || 'mongodb://rsf_mock:local_mock_only@localhost:27017/rsf_utility?authSource=admin';
const databaseName = process.env.DATABASE_NAME || 'rsf_utility';

let client;
let database;

export async function connectDatabase() {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  database = client.db(databaseName);
  await Promise.all([
    database.collection('inbound_messages').createIndex({ action: 1, message_id: 1 }, { unique: true }),
    database.collection('order_snapshots').createIndex({ transaction_id: 1, order_id: 1, receiver_id: 1 }, { unique: true }),
    database.collection('order_snapshots').createIndex({ subscriber_url: 1 }),
    database.collection('order_snapshots').createIndex({ subscriber_url: 1, receiver_send_state: 1, _id: 1 }),
    database.collection('order_snapshots').createIndex({ subscriber_url: 1, has_received_recon: 1, _id: 1 }),
    database.collection('routing_contexts').createIndex({ subscriber_url: 1, transaction_id: 1, order_id: 1 }),
    database.collection('mock_settlements').createIndex({ transaction_id: 1, order_id: 1, receiver_id: 1, cycle: 1 }, { unique: true }),
    database.collection('reconciliation_cases').createIndex({ transaction_id: 1, created_at: -1 }),
    database.collection('reconciliation_cases').createIndex({ subscriber_url: 1 }),
    database.collection('reconciliation_cases').createIndex({ subscriber_url: 1, source_type: 1, transaction_id: 1, created_at: -1 }),
    database.collection('receiver_drafts').createIndex({ subscriber_url: 1, created_at: -1 }),
    database.collection('outbound_messages').createIndex({ message_id: 1 }, { unique: true })
  ]);
  return database;
}

export function db() {
  if (!database) throw new Error('MongoDB connection is not ready');
  return database;
}

export async function closeDatabase() {
  if (client) await client.close();
}
