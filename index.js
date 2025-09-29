const io = require('socket.io-client');
const { createClient } = require('@supabase/supabase-js');

// --- Supabase setup ---
const supabaseUrl = 'https://nzsabxdvvtidiqqwyazk.supabase.co'; // your Supabase project URL
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56c2FieGR2dnRpZGlxcXd5YXprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgxNjcwMDgsImV4cCI6MjA3Mzc0MzAwOH0.W1rN_qEnb4Z8oI0g7G4m3siuwBP0KUw35N9epfSn08Y'; // your Supabase key
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
