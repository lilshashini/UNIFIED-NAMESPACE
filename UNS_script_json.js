const io = require("socket.io-client");
require('dotenv').config();

const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

// --- Supabase setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Connect to the WebSocket ---
const socket = io.connect('https://virtualfactory.online:3000');

socket.on('connect', () => {
    console.log('Connected to virtualfactory.online WebSocket');
});

socket.on('update', async (data) => {
    console.log('Received update:', JSON.stringify(data, null, 2));

    // --- Insert the entire data object into Supabase ---
    const row = {
        data: data,              // store entire object
        timestamp: new Date()    // current timestamp
    };

    const { error } = await supabase.from('mqtt_data').insert([row]);
    if (error) {
        console.error('Supabase insert error:', error);
    } else {
        console.log('Inserted 1 update into Supabase');
    }
});

socket.on('disconnect', () => {
    console.log('Disconnected from WebSocket');
});
