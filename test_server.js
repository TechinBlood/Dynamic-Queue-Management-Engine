const http = require('http');
const fs = require('fs');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync('C:/Users/viraj/OneDrive/Desktop/SIH_Mandi_Engine/index.html'));
});

server.listen(4321, () => {
  console.log('Local test server running at http://localhost:4321');
  setTimeout(() => { process.exit(0); }, 3000);
});
