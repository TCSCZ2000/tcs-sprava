-- Nová role Individuální (hodnota enumu musí vzniknout v samostatné transakci)
alter type app_role add value if not exists 'custom';
