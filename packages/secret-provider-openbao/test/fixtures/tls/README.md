# TEST-ONLY TLS fixtures

Certificates and private keys for the fake OpenBao server in `src/server/*.test.ts`. They protect
nothing: the keys are committed on purpose, and nothing outside these tests may trust them.

- `test-only-ca.pem`: the CA that signed the server and client certificates (its key is not kept).
- `test-only-other-ca.pem`: an unrelated CA, for the «wrong CA» test.
- `test-only-server.pem` / `.key.pem`: the fake server, for `127.0.0.1` and `localhost`.
- `test-only-client.pem` / `.key.pem`: the Hub's client certificate for the `cert` sign-in.

`generate.sh` makes a new set (valid for 100 years).
