-- Pano Merkezi kendi yetkileriyle korunur. Böylece üretim siparişlerini gören
-- her rol otomatik olarak pano teknik kayıtlarına erişmez.
INSERT IGNORE INTO `Permission` (`id`, `permissionName`) VALUES
    ('panel_view', 'panels.view'),
    ('panel_manage', 'panels.manage');

-- Sistem yöneticileri yeni alanı da eksiksiz yönetir.
INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT r.`id`, p.`id`
  FROM `Role` r
  JOIN `Permission` p ON p.`permissionName` IN ('panels.view', 'panels.manage')
 WHERE r.`isSystemAdmin` = true;

-- Her şirket ağacının kökünde hazır Elektrik Mühendisi rolü. Rol şablonları
-- ilk açıldığında servis alt şirket modül satırlarını da tamamlar.
INSERT INTO `Role` (`id`, `tenantId`, `roleName`, `pageLevels`)
SELECT CONCAT('elec_', LEFT(MD5(t.`id`), 20)),
       t.`id`,
       'Elektrik Mühendisi',
       JSON_OBJECT('production.panels', 2)
  FROM `Tenant` t
 WHERE t.`parentTenantId` IS NULL
   AND NOT EXISTS (
       SELECT 1 FROM `Role` r
        WHERE r.`tenantId` = t.`id` AND r.`roleName` = 'Elektrik Mühendisi'
   );

INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`)
SELECT r.`id`, p.`id`
  FROM `Role` r
  JOIN `Permission` p ON p.`permissionName` IN ('panels.view', 'panels.manage')
 WHERE r.`roleName` = 'Elektrik Mühendisi';

INSERT IGNORE INTO `RoleModuleConfig` (`roleId`, `tenantId`, `moduleKeys`)
SELECT r.`id`, r.`tenantId`, JSON_ARRAY('production')
  FROM `Role` r
 WHERE r.`roleName` = 'Elektrik Mühendisi';
