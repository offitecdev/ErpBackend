import os

def kodlari_birlestir(proje_dizini, cikti_dosyasi):
    # Taranmayacak gereksiz veya derlenmiş klasörler
    dislanan_klasorler = {'.git', 'venv', 'env', 'node_modules', '__pycache__', '.idea', '.vscode', 'bin', 'obj', 'migrations'}
    
    # Sadece bu uzantılara sahip dosyalar okunacak
    gecerli_uzantilar = {'.py' , '.js','.ts','.prisma'}

    with open(cikti_dosyasi, 'w', encoding='utf-8') as cikti:
        for kok_dizin, klasorler, dosyalar in os.walk(proje_dizini):
            klasorler[:] = [k for k in klasorler if k not in dislanan_klasorler]
            
            for dosya_adi in dosyalar:
                _, uzanti = os.path.splitext(dosya_adi)
                
                # Dosya uzantısı kontrolü
                if uzanti.lower() in gecerli_uzantilar:
                    dosya_yolu = os.path.join(kok_dizin, dosya_adi)
                    
                    try:
                        with open(dosya_yolu, 'r', encoding='utf-8') as dosya:
                            icerik = dosya.read()
                            
                            # Hangi kodun hangi dosyadan geldiğini ayırmak için başlık ekle
                            cikti.write(f"\n{'='*60}\n")
                            cikti.write(f"DOSYA: {dosya_yolu}\n")
                            cikti.write(f"{'='*60}\n\n")
                            cikti.write(icerik)
                            cikti.write("\n")
                    except Exception as e:
                        print(f"Okunurken hata oluştu ({dosya_yolu}): {e}")

    print(f"İşlem başarılı! Tüm kodlar '{cikti_dosyasi}' dosyasına aktarıldı.")

if __name__ == "__main__":
    # Aramanın yapılacağı dizin ('.' betiğin çalıştığı klasörü ifade eder)
    proje_klasoru = '.' 
    
    # Oluşturulacak metin dosyasının adı
    hedef_dosya = 'tum_proje_kodlari.txt' 
    
    kodlari_birlestir(proje_klasoru, hedef_dosya)