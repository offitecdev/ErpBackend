"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerSpec = void 0;
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'OFFITEC ERP API',
            version: '1.0.0',
            description: 'OFFITEC Kurumsal ERP Sistemi API Dokümantasyonu',
        },
        servers: [
            {
                url: process.env.SWAGGER_SERVER_URL || 'https://demo.offitec.ch/backend/api/v1',
                description: 'Production',
            },
            {
                url: 'http://localhost:3000/api/v1',
                description: 'Local',
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
            schemas: {
                Error: {
                    type: 'object',
                    properties: {
                        error: { type: 'string', example: 'Hata mesajı burada yazar.' }
                    }
                },
                LoginRequest: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string', example: 'admin@offitec.com' },
                        password: { type: 'string', example: '123456' }
                    }
                },
                LoginResponse: {
                    type: 'object',
                    properties: {
                        token: { type: 'string' },
                        employee: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                firstName: { type: 'string' },
                                lastName: { type: 'string' },
                                tenantId: { type: 'string' }
                            }
                        }
                    }
                },
                TenantCreateRequest: {
                    type: 'object',
                    required: ['tenantName'],
                    properties: {
                        tenantName: { type: 'string', example: 'OFFITEC Merkez' },
                        parentTenantId: { type: 'string', nullable: true, example: 'Alt şubeyse buraya üst şirketin IDsi yazılır' }
                    }
                },
                TenantUpdateRequest: {
                    type: 'object',
                    properties: {
                        tenantName: { type: 'string', example: 'OFFITEC Yeni İsim' },
                        isActive: { type: 'boolean', example: false },
                        parentTenantId: { type: 'string', nullable: true }
                    }
                },
                TenantResponse: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        tenantName: { type: 'string' },
                        isActive: { type: 'boolean' },
                        parentTenantId: { type: 'string', nullable: true },
                        createdAt: { type: 'string', format: 'date-time' }
                    }
                },
                CreateEmployeeRequest: {
                    type: 'object',
                    required: ['firstName', 'lastName', 'email', 'password'],
                    properties: {
                        firstName: { type: 'string', example: 'Ahmet' },
                        lastName: { type: 'string', example: 'Yilmaz' },
                        email: { type: 'string', format: 'email', example: 'ahmet.yilmaz@offitec.com' },
                        password: { type: 'string', example: 'SecurePassword123!' },
                        title: { type: 'string', example: 'Senior Developer' },
                        departmentId: { type: 'string', example: 'it-dept' },
                        roleName: { type: 'string', example: 'Mühendis' },
                        phone: { type: 'string', example: '+90 555 123 4567' },
                        address: { type: 'string', example: 'İstanbul, Türkiye' },
                        hireDate: { type: 'string', format: 'date-time', example: '2026-01-15T00:00:00Z' },
                        annualLeaveEntitlement: { type: 'integer', example: 14 },
                        notes: { type: 'string', example: 'Personel hakkında not' }
                    }
                },
                UpdateEmployeeRequest: {
                    type: 'object',
                    properties: {
                        firstName: { type: 'string' },
                        lastName: { type: 'string' },
                        title: { type: 'string' },
                        departmentId: { type: 'string' },
                        roleName: { type: 'string' },
                        phone: { type: 'string' },
                        address: { type: 'string' },
                        isActive: { type: 'boolean' },
                        annualLeaveEntitlement: { type: 'integer' },
                        notes: { type: 'string' },
                        terminationDate: { type: 'string', format: 'date-time' }
                    }
                },
                CreateLeaveRequest: {
                    type: 'object',
                    required: ['leaveTypeId', 'startDate', 'endDate'],
                    properties: {
                        leaveTypeId: { type: 'string', example: '789a1234-b56c-78de-f901-234567890123' },
                        startDate: { type: 'string', format: 'date-time', example: '2026-06-01T00:00:00Z' },
                        endDate: { type: 'string', format: 'date-time', example: '2026-06-10T00:00:00Z' },
                        description: { type: 'string', nullable: true, example: 'Yaz tatili' }
                    }
                },
                EvaluateLeaveRequest: {
                    type: 'object',
                    required: ['isapproved'],
                    properties: {
                        isapproved: { type: 'boolean', example: true },
                    }
                },
                CreateCustomerRequest: {
                    type: 'object',
                    required: ['companyName'],
                    properties: {
                        companyName: { type: 'string', example: 'Tech Corp A.Ş.' },
                        segment: { type: 'string', example: 'Enterprise' },
                        taxOffice: { type: 'string', example: 'Mecidiyeköy' },
                        taxNumber: { type: 'string', example: '1234567890' },
                        address: { type: 'string', example: 'Levent, İstanbul' },
                        mainPhone: { type: 'string', example: '+90 212 123 45 67' },
                        mainEmail: { type: 'string', format: 'email', example: 'info@techcorp.com' }
                    }
                },
                AddCustomerNoteRequest: {
                    type: 'object',
                    required: ['noteText', 'noteType'],
                    properties: {
                        noteText: { type: 'string', example: 'Müşteri ile SLA sözleşmesi yenilendi.' },
                        noteType: { type: 'string', enum: ['internal', 'technical'], example: 'internal' },
                        isHighlight: { type: 'boolean', description: 'Kritik not vurgulama', example: true }
                    }
                }
            }
        },
        security: [{ bearerAuth: [] }],
    },
    apis: ['./src/presentation/routes/*.ts'],
};
exports.swaggerSpec = (0, swagger_jsdoc_1.default)(options);
//# sourceMappingURL=swagger.config.js.map