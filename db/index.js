const { Client } = require("pg");

const client = new Client({
  connectionString: "postgresql://postgres:1234@localhost/user-data"
});

client.connect();

module.exports = client;