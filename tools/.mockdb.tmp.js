const mysql = require("mysql2")
const srv = mysql.createServer((conn) => {
  conn.serverHandshake({
    protocolVersion: 10, serverVersion: "5.7.10-mock", connectionId: 1,
    statusFlags: 2, capabilityFlags: 0xffffff, characterSet: 8,
    authPluginDataLength: 0, authPluginName: "mysql_native_password",
  })
  const handlePacket = conn.handlePacket.bind(conn)
  conn.handlePacket = (packet) => { handlePacket(packet); conn._resetSequenceId() }
  conn.on("query", (query) => {
    console.error("MOCK query:", query.slice(0, 60))
    if (query.startsWith("SHOW COLUMNS")) conn.writeTextResult([{ Field: "accountid" }, { Field: "cf_638" }], [{ name: "Field" }, { name: "Type" }])
    else if (query.startsWith("SELECT COUNT")) conn.writeTextResult([{ n: "3" }], [{ name: "n" }])
    else conn.writeTextResult([{ vtigerId: 1 }], [{ name: "vtigerId" }])
  })
  conn.on("error", (e) => console.error("MOCK conn error:", e.message))
})
srv.listen(0, "127.0.0.1", () => console.log(srv._server.address().port))
