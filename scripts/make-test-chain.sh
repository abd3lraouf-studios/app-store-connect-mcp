set -e
D=$1; mkdir -p "$D"; cd "$D"
# Apple's verifier requires these exact OIDs on the chain, so a test chain must
# carry them too: 1.2.840.113635.100.6.2.1 on the intermediate,
# 1.2.840.113635.100.6.11.1 on the leaf.
cat > int.cnf <<'X'
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
1.2.840.113635.100.6.2.1=critical,ASN1:NULL
X
cat > leaf.cnf <<'X'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
1.2.840.113635.100.6.11.1=critical,ASN1:NULL
X
openssl ecparam -name prime256v1 -genkey -noout -out root.key 2>/dev/null
openssl req -x509 -new -key root.key -sha256 -days 3650 -out root.pem -subj "/CN=Test Root CA/O=Test" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out int.key 2>/dev/null
openssl req -new -key int.key -out int.csr -subj "/CN=Test Intermediate/O=Test" 2>/dev/null
openssl x509 -req -in int.csr -CA root.pem -CAkey root.key -CAcreateserial -days 3000 -sha256 -extfile int.cnf -out int.pem 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out leaf.key 2>/dev/null
openssl req -new -key leaf.key -out leaf.csr -subj "/CN=Test Leaf/O=Test" 2>/dev/null
openssl x509 -req -in leaf.csr -CA int.pem -CAkey int.key -CAcreateserial -days 2000 -sha256 -extfile leaf.cnf -out leaf.pem 2>/dev/null
for n in root int leaf; do openssl x509 -in $n.pem -outform DER -out $n.der; done
echo OK
