import base64
import os
from Crypto.Cipher import AES

def encrypt_password(plain_password, secret_key):
    key = secret_key.encode('utf-8')[:32].ljust(32, b'\0') 
    iv = os.urandom(12)
    
    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    ciphertext, tag = cipher.encrypt_and_digest(plain_password.encode('utf-8'))
    
    encrypted_payload = base64.b64encode(iv + tag + ciphertext).decode('utf-8')
    return encrypted_payload

if __name__ == "__main__":
    db_password = input("MariaDB Şifresini Girin (Gizli kalacak): ")
    master_key = "OFFITEC_SUPER_SECRET_MASTER_KEY" 
    
    encrypted = encrypt_password(db_password, master_key)
    print(f"\n[BAŞARILI] .env dosyanıza kopyalayacağınız değer:")
    print(f"OFFITEC_DB_ENCRYPTED_PASS=\"{encrypted}\"")